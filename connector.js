'use strict';

/* =========================================================================
   WhatsApp Connector v4.0.0 — full-featured, Ubuntu-ready
   Five connection methods:
     1. GET  /qr                       -> raw QR string (fastest)
     2. GET  /qr-image                 -> base64 PNG
     3. GET  /qr-terminal              -> ASCII QR (for terminal users)
     4. POST /pair   {phone}           -> 8-char pairing code
     5. POST /restore                  -> reuse saved auth (auto-resume)
   Plus:
     POST /reset          -> wipe auth, force fresh session
     POST /disconnect     -> logout + wipe
     POST /connect        -> begin QR flow
     POST /send-message   -> text
     POST /send-media     -> image/video/audio/document/location/contact
     POST /backup         -> tar.gz auth_info and download URL
     POST /restore-backup -> upload tar.gz to restore session
   ========================================================================= */

const express        = require('express');
const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const pino           = require('pino');
const crypto         = require('crypto');
const QRCode         = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { exec }       = require('child_process');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

/* ------------------------------ config ---------------------------------- */
const PORT          = parseInt(process.env.PORT || '3000', 10);
const HOST          = process.env.HOST || '127.0.0.1';
const AUTH_DIR      = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');
const BACKUP_DIR    = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const LOG_LEVEL     = process.env.LOG_LEVEL || 'info';
const API_TOKEN     = process.env.API_TOKEN || '';
const PANEL_HOOK    = process.env.PANEL_WEBHOOK_URL || '';
const HOOK_SECRET   = process.env.PANEL_WEBHOOK_SECRET || '';
const QR_AS_IMAGE   = process.env.QR_AS_IMAGE === '1';
const TERMINAL_QR   = process.env.TERMINAL_QR !== '0';   // default: show in terminal

const logger = pino({
  level: LOG_LEVEL,
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true } },
});

const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------- state ---------------------------------- */
const state = {
  status: 'disconnected',        // disconnected | connecting | qr | pairing | connected | error
  phone: '',
  name: '',
  connected_at: 0,
  qr: '',
  qr_image: '',
  qr_terminal: '',
  qr_expires_at: 0,
  pairing_code: '',
  pairing_phone: '',
  last_error: '',
  last_change: Date.now(),
  mode: '',
  reconnect_count: 0,
  uptime_start: Date.now(),
};

let sock = null;
let starting = false;
let stopRequested = false;
let reconnectTimer = null;
let watchdog = null;

/* ------------------------------ helpers --------------------------------- */
function setStatus(s, extra = {}) {
  state.status = s;
  Object.assign(state, extra);
  state.last_change = Date.now();

  if (s !== 'qr') {
    state.qr = '';
    state.qr_image = '';
    state.qr_terminal = '';
    state.qr_expires_at = 0;
  }
  if (s !== 'pairing') {
    state.pairing_code = '';
    state.pairing_phone = '';
  }
  logger.info({ status: s, mode: state.mode, phone: state.phone }, 'state');
}

function jidFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? digits + '@s.whatsapp.net' : null;
}

async function forwardToPanel(event, data) {
  if (!PANEL_HOOK) return;
  try {
    const body = JSON.stringify({ event, timestamp: nowSec(), data });
    const headers = { 'Content-Type': 'application/json' };
    if (HOOK_SECRET) {
      headers['X-Webhook-Signature'] =
        crypto.createHmac('sha256', HOOK_SECRET).update(body).digest('hex');
    }
    await fetch(PANEL_HOOK, { method: 'POST', headers, body });
  } catch (e) {
    logger.warn({ e: e.message }, 'panel webhook failed');
  }
}

function wipeAuthDir() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      logger.info({ dir: AUTH_DIR }, 'auth directory wiped');
    }
  } catch (e) {
    logger.warn({ e: e.message }, 'auth wipe failed');
  }
}

function ensureDirs() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

async function teardownSocket() {
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (_) {}
    try { sock.end(undefined); }           catch (_) {}
    try { sock.ws?.close(); }              catch (_) {}
    sock = null;
  }
  starting = false;
  await new Promise(r => setTimeout(r, 300));
}

function waitSocketOpen(s, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        const ws = s?.ws;
        if (ws && (ws.isOpen === true || ws.readyState === 1)) return resolve();
      } catch (_) {}
      if (Date.now() - start > timeoutMs) return reject(new Error('Socket open timeout'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

/* --------------------------- socket lifecycle --------------------------- */
async function startSocket(mode = 'qr', pairingPhone = '') {
  await teardownSocket();
  ensureDirs();

  starting = true;
  stopRequested = false;
  state.mode = mode;

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    setStatus('connecting');

    const created = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(
          authState.keys,
          pino({ level: 'silent' }),
        ),
      },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      generateHighQualityLinkPreview: false,
      qrTimeout: 60000,
      emitOwnEvents: false,
      retryRequestDelayMs: 500,
    });

    sock = created;
    created.ev.on('creds.update', saveCreds);

    created.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u || {};

      /* --- QR --- */
      if (qr && state.mode === 'qr') {
        try {
          state.qr = qr;

          state.qr_image = await QRCode.toDataURL(qr, {
            margin: 1, width: 512, errorCorrectionLevel: 'M',
          });

          if (TERMINAL_QR) {
            qrcodeTerminal.generate(qr, { small: true }, (ascii) => {
              state.qr_terminal = ascii;
              console.log('\n=== SCAN THIS QR WITH WHATSAPP ===\n');
              console.log(ascii);
              console.log('==================================\n');
            });
          }

          state.qr_expires_at = nowSec() + 45;
          setStatus('qr');
        } catch (e) {
          logger.error({ e: e.message }, 'qr encode failed');
        }
      }

      /* --- Connected --- */
      if (connection === 'open') {
        const user = created.user || {};
        const phone = (user.id || '').split(':')[0].split('@')[0];
        state.reconnect_count = 0;
        setStatus('connected', {
          phone,
          name: user.name || user.verifiedName || '',
          connected_at: nowSec(),
          last_error: '',
          mode: '',
        });
        forwardToPanel('whatsapp.connected', { phone, name: user.name || '' });
        logger.info({ phone }, '✓ connected');
      }

      /* --- Closed --- */
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'connection closed';
        sock = null;
        starting = false;

        logger.warn({ code, reason }, 'connection closed');

        if (code === DisconnectReason.loggedOut) {
          wipeAuthDir();
          setStatus('disconnected', {
            phone: '', name: '', connected_at: 0,
            last_error: 'logged out', mode: '',
          });
          forwardToPanel('whatsapp.disconnected', { reason: 'logged_out' });
        } else if (!stopRequested) {
          state.reconnect_count++;
          const delay = Math.min(30000, 3000 * state.reconnect_count);
          setStatus('connecting', { last_error: reason });
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            logger.info({ delay, attempt: state.reconnect_count }, 'reconnecting');
            startSocket(state.mode || 'qr').catch(() => {});
          }, delay);
        } else {
          setStatus('disconnected', { last_error: reason, mode: '' });
          forwardToPanel('whatsapp.disconnected', { reason });
        }
      }
    });

    /* --- Inbound messages --- */
    created.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const from = (m.key.remoteJid || '').split('@')[0];
        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          m.message.imageMessage?.caption ||
          m.message.videoMessage?.caption ||
          '';
        forwardToPanel('message.received', {
          phone: from, message: text, message_id: m.key.id,
        });
      }
    });

    /* --- Pairing mode --- */
    if (mode === 'pair' && pairingPhone) {
      try {
        await waitSocketOpen(created, 30000);
      } catch (e) {
        throw new Error('Socket open timeout — try again or use QR');
      }

      await new Promise(r => setTimeout(r, 800));
      if (!sock || sock !== created) throw new Error('Socket was replaced');

      let lastErr = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const code = await created.requestPairingCode(pairingPhone);
          state.pairing_code = code;
          state.pairing_phone = pairingPhone;
          setStatus('pairing');
          lastErr = null;

          logger.info({ code, attempt }, '✓ pairing code acquired');
          console.log('\n=== PAIRING CODE ===\n');
          console.log('  ' + code);
          console.log('\nEnter this on your phone:');
          console.log('  WhatsApp → Settings → Linked Devices → Link with phone number\n');

          forwardToPanel('whatsapp.pairing', { code, phone: pairingPhone });
          break;
        } catch (e) {
          lastErr = e;
          logger.warn({ attempt, error: e.message }, 'pair attempt failed');
          await new Promise(r => setTimeout(r, 1800));
        }
      }
      if (lastErr) throw lastErr;
    }

  } catch (e) {
    logger.error({ e: e.message }, 'startSocket failed');
    setStatus('error', { last_error: e.message });
    throw e;
  } finally {
    starting = false;
  }
}

async function disconnectSocket() {
  stopRequested = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  await teardownSocket();
  wipeAuthDir();

  setStatus('disconnected', {
    phone: '', name: '', connected_at: 0,
    last_error: '', mode: '',
  });
}

async function resetSocket() {
  logger.info('full reset requested');
  stopRequested = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  await teardownSocket();
  wipeAuthDir();
  state.reconnect_count = 0;

  setStatus('disconnected', {
    phone: '', name: '', connected_at: 0,
    last_error: '', mode: '',
  });
}

async function restoreSession() {
  const files = fs.existsSync(AUTH_DIR) ? fs.readdirSync(AUTH_DIR) : [];
  const hasCreds = files.some(f => f.startsWith('creds'));
  if (!hasCreds) {
    throw new Error('No saved credentials found');
  }
  logger.info('restoring session from disk');
  return startSocket('qr');
}

/* ------------------------------ sending --------------------------------- */
async function sendOne(payload) {
  if (!sock || state.status !== 'connected') {
    const e = new Error('WhatsApp is not connected');
    e.code = 'WHATSAPP_NOT_CONNECTED';
    throw e;
  }

  const phone = String(payload.phone || '').replace(/\D/g, '');
  if (!phone) {
    const e = new Error('Invalid phone number');
    e.code = 'INVALID_PHONE'; throw e;
  }

  const jid = jidFromPhone(phone);
  const type = String(payload.type || 'text').toLowerCase();
  let content;

  switch (type) {
    case 'text': {
      const text = String(payload.message || '').trim();
      if (!text) { const e = new Error('Empty message'); e.code = 'INVALID_MESSAGE'; throw e; }
      content = { text };
      break;
    }
    case 'image':
      content = { image: { url: payload.url }, caption: payload.caption || undefined };
      break;
    case 'video':
      content = { video: { url: payload.url }, caption: payload.caption || undefined };
      break;
    case 'audio':
      content = { audio: { url: payload.url }, mimetype: 'audio/mp4', ptt: false };
      break;
    case 'document':
      content = {
        document: { url: payload.url },
        fileName: payload.filename || 'document.pdf',
        mimetype: 'application/octet-stream',
        caption: payload.caption || undefined,
      };
      break;
    case 'location':
      content = {
        location: {
          degreesLatitude: Number(payload.latitude),
          degreesLongitude: Number(payload.longitude),
          name: payload.name || undefined,
        },
      };
      break;
    case 'contact': {
      const cname = String(payload.name || '').trim();
      const cphone = String(payload.contact_phone || '').replace(/\D/g, '');
      if (!cname || !cphone) {
        const e = new Error('Contact name and phone required'); e.code = 'INVALID_MESSAGE'; throw e;
      }
      const vcard = [
        'BEGIN:VCARD','VERSION:3.0',`FN:${cname}`,
        `TEL;type=CELL;type=VOICE;waid=${cphone}:+${cphone}`,'END:VCARD',
      ].join('\n');
      content = { contacts: { displayName: cname, contacts: [{ vcard }] } };
      break;
    }
    default: {
      const e = new Error('Unsupported type: ' + type);
      e.code = 'INVALID_MESSAGE'; throw e;
    }
  }

  const r = await sock.sendMessage(jid, content);
  return r?.key?.id || '';
}

/* -------------------------------- server -------------------------------- */
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.raw({ type: 'application/gzip', limit: '20mb' }));

/* Optional token */
app.use((req, res, next) => {
  if (!API_TOKEN) return next();
  const hdr = req.headers['authorization'] || '';
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-connector-token'] || '');
  if (tok !== API_TOKEN) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Connector token invalid.' },
    });
  }
  next();
});

const ok   = (res, x = {}) => res.json({ success: true, ...x });
const fail = (res, m, c = 'ERROR', h = 400) =>
  res.status(h).json({ success: false, error: { code: c, message: m } });

/* ---------- root ---------- */
app.get('/', (_r, r) => r.json({
  service: 'wa-connector',
  version: '4.0.0',
  status: state.status,
  uptime: Math.floor((Date.now() - state.uptime_start) / 1000),
  methods: [
    'GET /status', 'GET /qr', 'GET /qr-image', 'GET /qr-terminal',
    'POST /connect', 'POST /pair {phone}', 'POST /restore',
    'POST /disconnect', 'POST /reset',
    'POST /send-message', 'POST /send-media',
    'POST /backup', 'POST /restore-backup',
  ],
}));

/* ---------- status ---------- */
app.get('/status', (_r, r) => ok(r, {
  status: state.status,
  phone: state.phone,
  name: state.name,
  connected_at: state.connected_at,
  pairing_code: state.pairing_code,
  pairing_phone: state.pairing_phone,
  last_error: state.last_error,
  reconnect_count: state.reconnect_count,
  uptime: Math.floor((Date.now() - state.uptime_start) / 1000),
}));

/* ---------- QR (raw string) ---------- */
app.get('/qr', async (_r, r) => {
  if (state.status === 'connected') return ok(r, { status: 'connected' });
  if (state.qr) {
    return ok(r, {
      status: 'qr',
      qr: QR_AS_IMAGE ? state.qr_image : state.qr,
      expires_at: state.qr_expires_at,
    });
  }
  if (!sock && !starting) startSocket('qr').catch(() => {});
  return ok(r, {
    status: state.status === 'disconnected' ? 'connecting' : state.status,
    qr: '',
  });
});

/* ---------- QR (base64 image) ---------- */
app.get('/qr-image', async (_r, r) => {
  if (state.status === 'connected') return ok(r, { status: 'connected' });
  if (state.qr_image) {
    return ok(r, {
      status: 'qr',
      qr: state.qr_image,
      expires_at: state.qr_expires_at,
    });
  }
  if (!sock && !starting) startSocket('qr').catch(() => {});
  return ok(r, {
    status: state.status === 'disconnected' ? 'connecting' : state.status,
    qr: '',
  });
});

/* ---------- QR (terminal ASCII) ---------- */
app.get('/qr-terminal', (_r, r) => {
  if (state.status === 'connected') return ok(r, { status: 'connected' });
  if (state.qr_terminal) {
    return ok(r, {
      status: 'qr',
      ascii: state.qr_terminal,
      expires_at: state.qr_expires_at,
    });
  }
  if (!sock && !starting) startSocket('qr').catch(() => {});
  ok(r, { status: 'connecting', ascii: '' });
});

/* ---------- connect ---------- */
app.post('/connect', async (_r, r) => {
  if (state.status === 'connected') return ok(r, { status: 'connected' });
  startSocket('qr').catch(() => {});
  ok(r, { status: 'connecting' });
});

/* ---------- pairing code ---------- */
app.post('/pair', async (req, res) => {
  const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) {
    return fail(res, 'Enter phone with country code', 'INVALID_PHONE', 422);
  }
  if (state.status === 'connected') {
    return fail(res, 'Already connected', 'ALREADY_CONNECTED', 409);
  }

  try {
    await startSocket('pair', phone);
    if (!state.pairing_code) {
      return fail(res, state.last_error || 'Failed to get pairing code', 'PAIR_FAILED', 500);
    }
    ok(res, { code: state.pairing_code, status: 'pairing', phone });
  } catch (e) {
    fail(res, e.message || 'Pair failed', 'PAIR_FAILED', 500);
  }
});

/* ---------- restore saved session ---------- */
app.post('/restore', async (_r, r) => {
  try {
    await restoreSession();
    ok(r, { status: state.status });
  } catch (e) {
    fail(r, e.message, 'RESTORE_FAILED', 500);
  }
});

/* ---------- disconnect ---------- */
app.post('/disconnect', async (_r, r) => {
  try {
    await disconnectSocket();
    ok(r, { status: 'disconnected' });
  } catch (e) {
    fail(r, e.message, 'DISCONNECT_FAILED', 500);
  }
});

/* ---------- reset (POST + GET) ---------- */
const resetHandler = async (_r, r) => {
  try {
    await resetSocket();
    ok(r, { status: 'disconnected' });
  } catch (e) {
    fail(r, e.message, 'RESET_FAILED', 500);
  }
};
app.post('/reset', resetHandler);
app.get('/reset',  resetHandler);

/* ---------- send ---------- */
async function handleSend(req, res) {
  try {
    const id = await sendOne(req.body || {});
    ok(res, { message_id: id, status: 'sent' });
  } catch (e) {
    const code = e.code || 'SEND_FAILED';
    const http =
      code === 'WHATSAPP_NOT_CONNECTED' ? 409 :
      (code === 'INVALID_PHONE' || code === 'INVALID_MESSAGE') ? 422 : 500;
    fail(res, e.message, code, http);
  }
}
app.post('/send-message', handleSend);
app.post('/send-media',   handleSend);

/* ---------- backup auth (tar.gz) ---------- */
app.post('/backup', async (_r, r) => {
  try {
    if (!fs.existsSync(AUTH_DIR)) return fail(r, 'No auth folder to backup', 'NO_AUTH', 400);
    ensureDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(BACKUP_DIR, `auth-backup-${stamp}.tar.gz`);

    await new Promise((resolve, reject) => {
      exec(`tar -czf ${JSON.stringify(out)} -C ${JSON.stringify(path.dirname(AUTH_DIR))} ${JSON.stringify(path.basename(AUTH_DIR))}`,
        (err) => err ? reject(err) : resolve());
    });

    const stat = fs.statSync(out);
    ok(r, {
      filename: path.basename(out),
      size: stat.size,
      download_url: `/backup/${path.basename(out)}`,
    });
  } catch (e) {
    fail(r, e.message, 'BACKUP_FAILED', 500);
  }
});

app.get('/backup/:file', (req, res) => {
  const f = path.join(BACKUP_DIR, path.basename(req.params.file));
  if (!fs.existsSync(f)) return res.status(404).end();
  res.download(f);
});

/* ---------- restore backup (upload tar.gz) ---------- */
app.post('/restore-backup', async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) {
      return fail(res, 'Send raw tar.gz as application/gzip', 'INVALID_BODY', 422);
    }
    const tmp = path.join(BACKUP_DIR, `upload-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmp, req.body);

    await teardownSocket();
    wipeAuthDir();

    await new Promise((resolve, reject) => {
      exec(`tar -xzf ${JSON.stringify(tmp)} -C ${JSON.stringify(path.dirname(AUTH_DIR))}`,
        (err) => err ? reject(err) : resolve());
    });
    fs.unlinkSync(tmp);

    await startSocket('qr');
    ok(res, { restored: true, status: state.status });
  } catch (e) {
    fail(res, e.message, 'RESTORE_FAILED', 500);
  }
});

/* ---------- health ---------- */
app.get('/health', (_r, r) => r.json({ ok: true, status: state.status }));

/* ------------------------------ watchdog -------------------------------- */
function startWatchdog() {
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => {
    const stuckFor = Date.now() - state.last_change;

    if (state.status === 'connecting' && stuckFor > 40000) {
      logger.warn({ stuckFor }, 'stuck in connecting — restarting');
      startSocket(state.mode || 'qr').catch(() => {});
      return;
    }

    if (state.status === 'qr' && state.qr_expires_at && nowSec() > state.qr_expires_at + 5) {
      logger.info('QR expired — regenerating');
      startSocket('qr').catch(() => {});
    }
  }, 5000);
}

/* ------------------------------ bootstrap ------------------------------- */
(async () => {
  ensureDirs();
  startWatchdog();

  if (fs.existsSync(AUTH_DIR)) {
    try {
      const files = fs.readdirSync(AUTH_DIR);
      if (files.some(f => f.startsWith('creds'))) {
        logger.info('existing session found — resuming');
        startSocket('qr').catch(() => {});
      }
    } catch (_) {}
  }

  app.listen(PORT, HOST, () => {
    logger.info(`wa-connector v4.0.0 listening on http://${HOST}:${PORT}`);
    logger.info(`auth dir: ${AUTH_DIR}`);
    logger.info(`backup dir: ${BACKUP_DIR}`);
    if (API_TOKEN) logger.info('API_TOKEN protection enabled');
    if (PANEL_HOOK) logger.info(`forwarding events to ${PANEL_HOOK}`);
    console.log('\nConnection methods:');
    console.log('  QR raw          GET  /qr');
    console.log('  QR base64       GET  /qr-image');
    console.log('  QR terminal     GET  /qr-terminal');
    console.log('  Pairing code    POST /pair {phone}');
    console.log('  Restore saved   POST /restore');
  });
})();

/* ------------------------------ shutdown -------------------------------- */
process.on('SIGINT',  async () => {
  logger.info('SIGINT — shutting down');
  try { await disconnectSocket(); } catch (_) {}
  process.exit(0);
});
process.on('SIGTERM', async () => {
  logger.info('SIGTERM — shutting down');
  try { await disconnectSocket(); } catch (_) {}
  process.exit(0);
});
process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
process.on('uncaughtException',  (e) => logger.error({ err: String(e) }, 'uncaughtException'));
