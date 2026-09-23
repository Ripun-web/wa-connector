'use strict';

/* =========================================================================
   WhatsApp Connector — full version for the PHP API Panel
   Runtime: Node.js 18+  |  Library: @whiskeysockets/baileys
   HTTP contract expected by index.php:
     GET  /                -> redirects to /connect
     GET  /connect         -> HTML page with QR + pairing UI
     GET  /status          -> JSON status
     GET  /qr              -> raw QR string (or base64 if QR_AS_IMAGE=1)
     GET  /qr-image        -> base64 data URL
     POST /connect         -> start socket in QR mode
     POST /pair            -> body {phone:"91..."} -> pairing code
     POST /disconnect      -> logout + wipe auth
     POST /reset | GET /reset -> wipe auth, reset state
     POST /send-message    -> text
     POST /send-media      -> image / video / audio / document / location / contact
   ========================================================================= */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const pino    = require('pino');
const crypto  = require('crypto');
const QRCode  = require('qrcode');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');

/* ------------------------------ config ---------------------------------- */
const PORT        = parseInt(process.env.PORT || '3000', 10);
const HOST        = process.env.HOST || '0.0.0.0';
const AUTH_DIR    = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');
const LOG_LEVEL   = process.env.LOG_LEVEL || 'info';
const API_TOKEN   = process.env.API_TOKEN || '';
const PANEL_HOOK  = process.env.PANEL_WEBHOOK_URL || '';
const HOOK_SECRET = process.env.PANEL_WEBHOOK_SECRET || '';
const QR_AS_IMAGE = process.env.QR_AS_IMAGE === '1';

const logger = pino({ level: LOG_LEVEL });
const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------- state ---------------------------------- */
const state = {
  status: 'disconnected',        // disconnected | connecting | qr | pairing | connected | error
  phone: '',
  name: '',
  connected_at: 0,
  qr: '',                        // RAW string by default
  qr_image: '',                  // base64 data URL (always populated)
  qr_expires_at: 0,
  pairing_code: '',
  pairing_phone: '',
  last_error: '',
  last_change: Date.now(),
  mode: '',                      // 'qr' | 'pair' | ''
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
    logger.warn({ e: e.message }, 'panel webhook forward failed');
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
        if (ws && (ws.isOpen === true || ws.readyState === 1)) {
          return resolve();
        }
      } catch (_) {}
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Socket open timeout'));
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

/* --------------------------- socket lifecycle --------------------------- */
async function startSocket(mode = 'qr', pairingPhone = '') {
  await teardownSocket();

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

      if (qr && state.mode === 'qr') {
        try {
          state.qr = qr;
          state.qr_image = await QRCode.toDataURL(qr, {
            margin: 1,
            width: 512,
            errorCorrectionLevel: 'M',
          });
          state.qr_expires_at = nowSec() + 45;
          setStatus('qr');
        } catch (e) {
          logger.error({ e: e.message }, 'qr encode failed');
        }
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
        logger.info({ phone }, 'connected');
      }

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
          logger.info({ code, attempt }, 'pairing code acquired');
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

  setStatus('disconnected', {
    phone: '', name: '', connected_at: 0,
    last_error: '', mode: '',
  });
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
    e.code = 'INVALID_PHONE';
    throw e;
  }
  const jid = jidFromPhone(phone);
  const type = String(payload.type || 'text').toLowerCase();
  let content;

  switch (type) {
    case 'text': {
      const text = String(payload.message || '').trim();
      if (!text) {
        const e = new Error('Empty message'); e.code = 'INVALID_MESSAGE'; throw e;
      }
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
        const e = new Error('Contact name and phone required');
        e.code = 'INVALID_MESSAGE'; throw e;
      }
      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${cname}`,
        `TEL;type=CELL;type=VOICE;waid=${cphone}:+${cphone}`,
        'END:VCARD',
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

/* ---------- connect page (HTML) ---------- */
function renderConnectPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect WhatsApp</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(180deg,#f0fdf4,#f7f8fa 40%);
    font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827}
  .card{width:min(520px,calc(100% - 32px));background:#fff;border:1px solid #e5e7eb;
    border-radius:20px;padding:32px;box-shadow:0 20px 60px rgba(0,0,0,.08)}
  .logo{width:56px;height:56px;border-radius:15px;background:#25D366;color:#fff;
    display:grid;place-items:center;font-weight:900;font-size:22px;margin-bottom:18px}
  h1{margin:0 0 6px;font-size:22px}
  p.sub{color:#6b7280;margin:0 0 22px;font-size:14px}
  .tabs{display:flex;gap:6px;background:#f3f4f6;border-radius:10px;padding:4px;margin-bottom:20px}
  .tab{flex:1;padding:9px;border-radius:7px;font-weight:700;font-size:13px;color:#6b7280;
    cursor:pointer;text-align:center;user-select:none}
  .tab.active{background:#fff;color:#111827;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  .pane{display:none}
  .pane.active{display:block}
  .qrbox{width:260px;height:260px;margin:0 auto 16px;border:1px solid #e5e7eb;
    border-radius:14px;background:#fff;display:flex;align-items:center;justify-content:center;
    overflow:hidden;position:relative}
  .qrbox img{width:100%;height:100%;object-fit:contain}
  .spin{width:38px;height:38px;border:3px solid #e5e7eb;border-top-color:#25D366;
    border-radius:50%;animation:spin .9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .status{text-align:center;font-weight:700;font-size:14px;margin-bottom:6px}
  .hint{text-align:center;color:#6b7280;font-size:12.5px;line-height:1.6;margin-bottom:14px}
  .steps{background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;
    font-size:12.5px;color:#374151;line-height:1.9}
  .steps b{color:#111827}
  .input{width:100%;padding:11px 12px;border:1px solid #d1d5db;border-radius:9px;
    font-size:14px;outline:none;margin-bottom:10px}
  .input:focus{border-color:#86efac;box-shadow:0 0 0 3px rgba(37,211,102,.12)}
  button{width:100%;padding:11px;border:0;border-radius:9px;font-weight:700;font-size:14px;
    cursor:pointer;transition:.15s}
  .btn-primary{background:#25D366;color:#fff}
  .btn-primary:hover{background:#18a957}
  .btn-danger{background:#fff;border:1px solid #fecaca;color:#dc2626;margin-top:10px}
  .btn-danger:hover{background:#fef2f2}
  .btn-ghost{background:#f3f4f6;color:#374151;margin-top:8px}
  .btn-ghost:hover{background:#e5e7eb}
  .paircode{font-family:ui-monospace,Menlo,monospace;font-size:30px;font-weight:900;
    letter-spacing:6px;text-align:center;padding:20px;background:#f0fdf4;
    border:1px dashed #4ade80;border-radius:12px;margin-top:14px;display:none}
  .paircode.show{display:block}
  .error{color:#dc2626;font-size:13px;text-align:center;margin-top:10px}
  .ok{color:#059669;font-size:13px;text-align:center;margin-top:10px}
  .foot{margin-top:20px;font-size:12px;color:#9ca3af;text-align:center}
  .foot a{color:#6b7280;text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <div class="logo">WA</div>
  <h1>Connect WhatsApp</h1>
  <p class="sub">Choose a method to link your WhatsApp account.</p>

  <div class="tabs">
    <div class="tab active" data-tab="qr">📷 QR Code</div>
    <div class="tab" data-tab="pair">🔢 Pairing Code</div>
  </div>

  <div class="pane active" id="pane-qr">
    <div class="qrbox" id="qrbox"><div class="spin"></div></div>
    <div class="status" id="status">Generating QR…</div>
    <div class="hint" id="hint">Waiting for connector to issue a QR code.</div>
    <div class="steps">
      <b>1.</b> Open WhatsApp on your phone<br>
      <b>2.</b> Settings → Linked Devices<br>
      <b>3.</b> Tap “Link a Device” and scan this code
    </div>
    <button class="btn-primary" id="newqr" style="margin-top:14px;display:none">Generate New QR</button>
  </div>

  <div class="pane" id="pane-pair">
    <p class="sub">Enter your WhatsApp number with country code (no + or spaces).</p>
    <input class="input" id="phone" placeholder="e.g. 916002322737" inputmode="numeric">
    <button class="btn-primary" id="getpair">Get Pairing Code</button>
    <div class="paircode" id="paircode"></div>
    <div class="error" id="pairerr"></div>
  </div>

  <button class="btn-danger" id="resetbtn">Reset Session</button>
  <button class="btn-ghost" id="disconnectbtn">Disconnect</button>

  <div class="foot" id="foot"></div>
</div>

<script>
'use strict';
const $ = id => document.getElementById(id);

async function api(action, opts) {
  opts = opts || {};
  const url = 'index.php?action=' + action;
  const res = await fetch(opts.endpoint || url, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  const j = await res.json();
  if (!j.success) throw (j.error || { message: 'Request failed.' });
  return j;
}

async function fetchStatus() {
  try {
    const r = await fetch('/status');
    const j = await r.json();
    return j;
  } catch (e) { return { status: 'offline' }; }
}

async function fetchQr() {
  try {
    const r = await fetch('/qr-image');
    const j = await r.json();
    return j;
  } catch (e) { return { status: 'offline', qr: '' }; }
}

/* ----- tab switching ----- */
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    document.querySelectorAll('.pane').forEach(p => {
      p.classList.toggle('active', p.id === 'pane-' + t.dataset.tab);
    });
    if (t.dataset.tab === 'qr') startQrLoop();
  });
});

/* ----- QR loop ----- */
let qrLoop = null;
let qrTicks = 0;
let qrFails = 0;

function stopQrLoop() {
  if (qrLoop) { clearInterval(qrLoop); qrLoop = null; }
}

async function startQrLoop() {
  stopQrLoop();
  qrTicks = 0; qrFails = 0;
  $('newqr').style.display = 'none';
  $('qrbox').innerHTML = '<div class="spin"></div>';
  $('status').textContent = 'Generating QR…';
  $('hint').textContent = 'Waiting for connector to issue a QR code.';

  try { await fetch('/connect', { method: 'POST' }); } catch (e) {}

  const tick = async () => {
    qrTicks++;
    try {
      const s = await fetchStatus();

      if (s.status === 'connected') {
        stopQrLoop();
        $('qrbox').innerHTML = '<div style="font-size:52px">✓</div>';
        $('status').textContent = 'WhatsApp Connected';
        $('hint').textContent = s.phone ? ('+' + s.phone) : '';
        $('foot').innerHTML = '<a href="/status" target="_blank">View status JSON</a>';
        return;
      }

      if (s.status === 'qr') {
        const q = await fetchQr();
        if (q.qr) {
          $('qrbox').innerHTML = '<img alt="QR" src="' + q.qr + '">';
          $('status').textContent = 'Waiting for scan…';
          $('hint').textContent = 'Open WhatsApp → Linked Devices → Link a Device.';
          $('newqr').style.display = 'none';
        }
        return;
      }

      if (s.status === 'connecting') {
        $('qrbox').innerHTML = '<div class="spin"></div>';
        $('status').textContent = 'Generating QR…';
        return;
      }

      if (qrTicks > 8) {
        $('qrbox').innerHTML = '<div style="color:#9ca3af;font-size:13px;padding:20px;text-align:center">QR unavailable</div>';
        $('status').textContent = 'QR expired';
        $('hint').textContent = 'Click “Generate New QR” to try again.';
        $('newqr').style.display = 'inline-block';
        stopQrLoop();
      }
    } catch (e) {
      qrFails++;
      if (qrFails > 3) {
        $('qrbox').innerHTML = '<div style="color:#dc2626;font-size:13px;padding:20px;text-align:center">Connector offline</div>';
        $('status').textContent = 'Connector Offline';
        stopQrLoop();
      }
    }
  };

  await tick();
  qrLoop = setInterval(tick, 2500);
}

/* ----- pairing ----- */
$('getpair').addEventListener('click', async () => {
  const phone = ($('phone').value || '').replace(/\D/g, '');
  if (phone.length < 8) {
    $('pairerr').textContent = 'Enter a valid phone with country code.';
    return;
  }
  $('pairerr').textContent = '';
  $('paircode').classList.remove('show');
  $('getpair').disabled = true;
  $('getpair').textContent = 'Requesting…';

  try {
    const r = await fetch('/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const j = await r.json();
    if (!j.success) throw (j.error || { message: 'Pairing failed.' });
    $('paircode').textContent = j.code;
    $('paircode').classList.add('show');
    startPairWatch();
  } catch (e) {
    $('pairerr').textContent = e.message || 'Pairing failed.';
  } finally {
    $('getpair').disabled = false;
    $('getpair').textContent = 'Get Pairing Code';
  }
});

function startPairWatch() {
  stopQrLoop();
  qrLoop = setInterval(async () => {
    try {
      const s = await fetchStatus();
      if (s.status === 'connected') {
        stopQrLoop();
        document.querySelector('.tab[data-tab="qr"]').click();
      }
    } catch (e) {}
  }, 2500);
}

/* ----- reset & disconnect ----- */
$('newqr').addEventListener('click', startQrLoop);

$('resetbtn').addEventListener('click', async () => {
  if (!confirm('Reset the session? This wipes auth and forces a fresh QR.')) return;
  try { await fetch('/reset', { method: 'POST' }); } catch (e) {}
  startQrLoop();
});

$('disconnectbtn').addEventListener('click', async () => {
  if (!confirm('Disconnect the current WhatsApp session?')) return;
  try { await fetch('/disconnect', { method: 'POST' }); } catch (e) {}
  startQrLoop();
});

/* ----- boot ----- */
(async () => {
  const s = await fetchStatus();
  if (s.status === 'connected') {
    $('qrbox').innerHTML = '<div style="font-size:52px">✓</div>';
    $('status').textContent = 'WhatsApp Connected';
    $('hint').textContent = s.phone ? ('+' + s.phone) : '';
    $('foot').innerHTML = '<a href="/status" target="_blank">View status JSON</a>';
    return;
  }
  startQrLoop();
})();
</script>
</body>
</html>`;
}

/* ---------- routes ---------- */
app.get('/', (_r, r) => r.redirect('/connect'));

app.get('/connect', (_r, r) => {
  r.set('Content-Type', 'text/html; charset=utf-8');
  r.send(renderConnectPage());
});

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

app.post('/connect', async (_r, r) => {
  if (state.status === 'connected') return ok(r, { status: 'connected' });
  startSocket('qr').catch(() => {});
  ok(r, { status: 'connecting' });
});

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

app.post('/disconnect', async (_r, r) => {
  try {
    await disconnectSocket();
    ok(r, { status: 'disconnected' });
  } catch (e) {
    fail(r, e.message, 'DISCONNECT_FAILED', 500);
  }
});

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

async function handleSend(req, res) {
  try {
    const id = await sendOne(req.body || {});
    ok(res, { message_id: id, status: 'sent' });
  } catch (e) {
    const code = e.code || 'SEND_FAILED';
    const http =
      code === 'WHATSAPP_NOT_CONNECTED' ? 409 :
      (code === 'INVALID_PHONE' || code === 'INVALID_MESSAGE') ? 422 :
      500;
    fail(res, e.message, code, http);
  }
}
app.post('/send-message', handleSend);
app.post('/send-media',   handleSend);

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

    if (
      state.status === 'qr' &&
      state.qr_expires_at &&
      nowSec() > state.qr_expires_at + 5
    ) {
      logger.info('QR expired — regenerating');
      startSocket('qr').catch(() => {});
    }
  }, 5000);
}

/* ------------------------------ bootstrap ------------------------------- */
(async () => {
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
    logger.info(`wa-connector v3.0.0 listening on http://${HOST}:${PORT}`);
    logger.info(`auth dir: ${AUTH_DIR}`);
    logger.info(`connect page: http://${HOST}:${PORT}/connect`);
    if (API_TOKEN) logger.info('API_TOKEN protection enabled');
    if (PANEL_HOOK) logger.info(`forwarding events to ${PANEL_HOOK}`);
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
process.on('unhandledRejection', (e) => {
  logger.error({ err: String(e) }, 'unhandledRejection');
});
process.on('uncaughtException', (e) => {
  logger.error({ err: String(e) }, 'uncaughtException');
});
