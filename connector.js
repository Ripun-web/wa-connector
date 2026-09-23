'use strict';
const express = require('express');
const QRCode  = require('qrcode');
const fs      = require('fs');
const path    = require('path');
const pino    = require('pino');
const crypto  = require('crypto');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const PORT       = parseInt(process.env.PORT || '3000', 10);
const HOST       = process.env.HOST || '0.0.0.0';
const AUTH_DIR   = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');
const API_TOKEN  = process.env.API_TOKEN || '';
const PANEL_HOOK = process.env.PANEL_WEBHOOK_URL || '';
const HOOK_SECRET= process.env.PANEL_WEBHOOK_SECRET || '';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const nowSec = () => Math.floor(Date.now() / 1000);

const state = {
  status: 'disconnected',
  phone: '', name: '', connected_at: 0,
  qr: '', qr_expires_at: 0,
  pairing_code: '', pairing_phone: '',
  last_error: '',
  last_change: Date.now(),
  mode: '',
};

let sock = null;
let starting = false;
let stopRequested = false;
let reconnectTimer = null;
let watchdog = null;

function setStatus(s, extra = {}) {
  state.status = s;
  Object.assign(state, extra);
  state.last_change = Date.now();
  if (s !== 'qr') { state.qr = ''; state.qr_expires_at = 0; }
  if (s !== 'pairing') state.pairing_code = '';
  logger.info({ status: s, phone: state.phone, mode: state.mode }, 'state');
}

function jidFromPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d ? d + '@s.whatsapp.net' : null;
}

async function forwardToPanel(event, data) {
  if (!PANEL_HOOK) return;
  try {
    const body = JSON.stringify({ event, timestamp: nowSec(), data });
    const headers = { 'Content-Type': 'application/json' };
    if (HOOK_SECRET) headers['X-Webhook-Signature'] =
      crypto.createHmac('sha256', HOOK_SECRET).update(body).digest('hex');
    await fetch(PANEL_HOOK, { method: 'POST', headers, body });
  } catch (e) { logger.warn({ e: e.message }, 'panel hook failed'); }
}

/* Fully tear down any existing socket so we can start fresh */
async function teardown() {
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (_) {}
    try { sock.end(undefined); } catch (_) {}
    sock = null;
  }
  starting = false;
}

/* Single start routine for both QR and Pairing modes.
   Pairing code is requested INSIDE here, after the socket is created. */
async function startSocket(mode = 'qr', pairingPhone = '') {
  await teardown();
  starting = true;
  stopRequested = false;
  state.mode = mode;

  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    setStatus('connecting');

    const created = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['WA Panel', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      qrTimeout: 60000,
    });
    sock = created;

    created.ev.on('creds.update', saveCreds);

    created.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u || {};

      if (qr && state.mode === 'qr') {
        try {
          state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 512 });
          state.qr_expires_at = nowSec() + 45;
          setStatus('qr');
        } catch (e) { logger.error({ e: e.message }, 'qr encode failed'); }
      }

      if (connection === 'open') {
        const user = created.user || {};
        const phone = (user.id || '').split(':')[0].split('@')[0];
        setStatus('connected', {
          phone,
          name: user.name || user.verifiedName || '',
          connected_at: nowSec(),
          last_error: '',
          mode: '',
        });
        forwardToPanel('whatsapp.connected', { phone, name: user.name || '' });
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'connection closed';
        sock = null;
        starting = false;

        if (code === DisconnectReason.loggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
          setStatus('disconnected', { phone: '', name: '', connected_at: 0, last_error: 'logged out', mode: '' });
          forwardToPanel('whatsapp.disconnected', { reason: 'logged_out' });
        } else if (!stopRequested) {
          setStatus('connecting', { last_error: reason });
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            startSocket(state.mode || 'qr').catch(() => {});
          }, 3000);
        } else {
          setStatus('disconnected', { last_error: reason, mode: '' });
          forwardToPanel('whatsapp.disconnected', { reason });
        }
      }
    });

    created.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const from = (m.key.remoteJid || '').split('@')[0];
        const text = m.message.conversation || m.message.extendedTextMessage?.text ||
          m.message.imageMessage?.caption || m.message.videoMessage?.caption || '';
        forwardToPanel('message.received', { phone: from, message: text, message_id: m.key.id });
      }
    });

    /* Pairing mode: wait for socket to be usable, then request the code */
    if (mode === 'pair' && pairingPhone) {
      await new Promise(r => setTimeout(r, 1500));
      if (!sock || sock !== created) throw new Error('Socket not ready for pairing');
      const code = await created.requestPairingCode(pairingPhone);
      state.pairing_code = code;
      state.pairing_phone = pairingPhone;
      setStatus('pairing');
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
  clearTimeout(reconnectTimer); reconnectTimer = null;
  await teardown();
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
  setStatus('disconnected', { phone: '', name: '', connected_at: 0, last_error: '', mode: '' });
}

async function sendOne(payload) {
  if (!sock || state.status !== 'connected') {
    const e = new Error('WhatsApp is not connected'); e.code = 'WHATSAPP_NOT_CONNECTED'; throw e;
  }
  const phone = String(payload.phone || '').replace(/\D/g, '');
  if (!phone) { const e = new Error('Invalid phone'); e.code = 'INVALID_PHONE'; throw e; }
  const jid = jidFromPhone(phone);
  const type = String(payload.type || 'text').toLowerCase();
  let content;

  switch (type) {
    case 'text':
      content = { text: String(payload.message || '') };
      if (!content.text) { const e = new Error('Empty text'); e.code = 'INVALID_MESSAGE'; throw e; }
      break;
    case 'image':    content = { image:    { url: payload.url }, caption: payload.caption || undefined }; break;
    case 'video':    content = { video:    { url: payload.url }, caption: payload.caption || undefined }; break;
    case 'audio':    content = { audio:    { url: payload.url }, mimetype: 'audio/mp4', ptt: false };    break;
    case 'document': content = { document: { url: payload.url }, fileName: payload.filename || 'document.pdf',
                                 mimetype: 'application/octet-stream', caption: payload.caption || undefined }; break;
    case 'location':
      content = { location: { degreesLatitude: Number(payload.latitude),
                              degreesLongitude: Number(payload.longitude),
                              name: payload.name || undefined } };
      break;
    case 'contact': {
      const cname = String(payload.name || '').trim();
      const cphone = String(payload.contact_phone || '').replace(/\D/g, '');
      if (!cname || !cphone) { const e = new Error('Contact name and phone required'); e.code = 'INVALID_MESSAGE'; throw e; }
      const vcard = ['BEGIN:VCARD','VERSION:3.0',`FN:${cname}`,
        `TEL;type=CELL;type=VOICE;waid=${cphone}:+${cphone}`,'END:VCARD'].join('\n');
      content = { contacts: { displayName: cname, contacts: [{ vcard }] } };
      break;
    }
    default: { const e = new Error('Unsupported type: ' + type); e.code = 'INVALID_MESSAGE'; throw e; }
  }
  const r = await sock.sendMessage(jid, content);
  return r?.key?.id || '';
}

/* ---------------- server ---------------- */
const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  if (!API_TOKEN) return next();
  const hdr = req.headers['authorization'] || '';
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-connector-token'] || '');
  if (tok !== API_TOKEN)
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
  next();
});

const ok   = (res, x = {}) => res.json({ success: true, ...x });
const fail = (res, m, c = 'ERROR', h = 400) =>
  res.status(h).json({ success: false, error: { code: c, message: m } });

app.get('/', (_r, r) => r.json({ service: 'wa-connector', version: '2.0.0', status: state.status }));

app.get('/status', (_r, r) => ok(r, {
  status: state.status,
  phone: state.phone,
  name: state.name,
  connected_at: state.connected_at,
  pairing_code: state.pairing_code,
  pairing_phone: state.pairing_phone,
  last_error: state.last_error,
}));

app.get('/qr', async (_r, r) => {
  if (state.status === 'connected') return ok(r, { status: 'connected' });
  if (state.qr) return ok(r, { status: 'qr', qr: state.qr, expires_at: state.qr_expires_at });
  if (!sock && !starting) startSocket('qr').catch(() => {});
  ok(r, { status: state.status === 'disconnected' ? 'connecting' : state.status, qr: '' });
});

app.post('/connect', async (_r, r) => {
  if (state.status === 'connected') return ok(r, { status: 'connected' });
  startSocket('qr').catch(() => {});
  ok(r, { status: 'connecting' });
});

app.post('/pair', async (req, res) => {
  const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15)
    return fail(res, 'Enter phone with country code', 'INVALID_PHONE', 422);
  if (state.status === 'connected')
    return fail(res, 'Already connected', 'ALREADY_CONNECTED', 409);

  try {
    await startSocket('pair', phone);
    if (!state.pairing_code)
      return fail(res, state.last_error || 'Failed to get pairing code', 'PAIR_FAILED', 500);
    ok(res, { code: state.pairing_code, status: 'pairing', phone });
  } catch (e) {
    fail(res, e.message || 'Pair failed', 'PAIR_FAILED', 500);
  }
});

app.post('/disconnect', async (_r, r) => {
  try { await disconnectSocket(); ok(r, { status: 'disconnected' }); }
  catch (e) { fail(r, e.message, 'DISCONNECT_FAILED', 500); }
});

app.post('/reset', async (_r, r) => {
  try {
    stopRequested = true;
    await teardown();
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
    setStatus('disconnected', { phone: '', name: '', connected_at: 0, last_error: '', mode: '' });
    ok(r, { status: 'disconnected' });
  } catch (e) { fail(r, e.message, 'RESET_FAILED', 500); }
});

async function handleSend(req, res) {
  try {
    const id = await sendOne(req.body || {});
    ok(res, { message_id: id, status: 'sent' });
  } catch (e) {
    const code = e.code || 'SEND_FAILED';
    const http = code === 'WHATSAPP_NOT_CONNECTED' ? 409 :
      (code === 'INVALID_PHONE' || code === 'INVALID_MESSAGE') ? 422 : 500;
    fail(res, e.message, code, http);
  }
}
app.post('/send-message', handleSend);
app.post('/send-media',   handleSend);

/* ---------------- watchdog ---------------- */
function startWatchdog() {
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => {
    // Stuck in "connecting" > 30s → force reset
    if (state.status === 'connecting' && Date.now() - state.last_change > 30000) {
      logger.warn('stuck in connecting — resetting');
      startSocket(state.mode || 'qr').catch(() => {});
    }
    // QR expired → regenerate
    if (state.status === 'qr' && state.qr_expires_at && nowSec() > state.qr_expires_at + 5) {
      logger.info('QR expired — regenerating');
      startSocket('qr').catch(() => {});
    }
  }, 5000);
}

/* ---------------- bootstrap ---------------- */
(async () => {
  startWatchdog();
  // Only auto-resume if we have a real creds file
  if (fs.existsSync(AUTH_DIR)) {
    const files = fs.readdirSync(AUTH_DIR);
    if (files.some(f => f.startsWith('creds'))) {
      logger.info('existing session found — resuming');
      startSocket('qr').catch(() => {});
    }
  }
  app.listen(PORT, HOST, () => logger.info(`wa-connector v2 listening on http://${HOST}:${PORT}`));
})();

process.on('SIGINT',  async () => { try { await disconnectSocket(); } catch(_){} process.exit(0); });
process.on('SIGTERM', async () => { try { await disconnectSocket(); } catch(_){} process.exit(0); });
