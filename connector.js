'use strict';
/* WhatsApp Connector v2.1.0 — fixed pairing + reset + proper state machine */

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

const PORT        = parseInt(process.env.PORT || '3000', 10);
const HOST        = process.env.HOST || '0.0.0.0';
const AUTH_DIR    = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');
const API_TOKEN   = process.env.API_TOKEN || '';
const PANEL_HOOK  = process.env.PANEL_WEBHOOK_URL || '';
const HOOK_SECRET = process.env.PANEL_WEBHOOK_SECRET || '';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const nowSec = () => Math.floor(Date.now() / 1000);

const state = {
  status: 'disconnected',      // disconnected | starting | qr | pairing | connecting | connected | error
  phone: '', name: '', connected_at: 0,
  qr: '', qr_expires_at: 0,
  pairing_code: '', pairing_phone: '',
  last_error: '',
  started_at: 0,
};

let sock = null;
let starting = false;
let stopRequested = false;
let reconnectTimer = null;
let currentMode = 'qr';         // 'qr' | 'pair'
let sockReadyResolve = null;
let sockReadyPromise = null;

function setStatus(s, extra = {}) {
  state.status = s;
  Object.assign(state, extra);
  if (s !== 'qr') { state.qr = ''; state.qr_expires_at = 0; }
  if (s !== 'pairing') { state.pairing_code = ''; state.pairing_phone = ''; }
  logger.info({ status: s, phone: state.phone, error: state.last_error || undefined }, 'state → ' + s);
}

function resetSockReady() {
  sockReadyPromise = new Promise((resolve) => { sockReadyResolve = resolve; });
}

async function waitForSock(timeoutMs = 15000) {
  if (sock) return sock;
  if (!sockReadyPromise) return null;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const winner = await Promise.race([sockReadyPromise, timeout]);
  return winner || sock || null;
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
  } catch (e) { logger.warn({ e: e.message }, 'panel webhook failed'); }
}

async function startSocket(mode = 'qr') {
  if (starting) {
    // Already starting — just wait for the existing socket
    return waitForSock();
  }
  if (sock) return sock;

  starting = true;
  stopRequested = false;
  currentMode = mode;
  resetSockReady();

  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    setStatus('starting', { started_at: nowSec(), last_error: '' });

    sock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['WA Panel', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
    });

    // Notify any waiters that sock exists
    if (sockReadyResolve) { sockReadyResolve(sock); sockReadyResolve = null; }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u || {};

      if (qr) {
        if (currentMode === 'qr') {
          try {
            state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 512 });
            state.qr_expires_at = nowSec() + 60;
            setStatus('qr');
          } catch (e) {
            logger.error({ e: e.message }, 'qr encode failed');
            setStatus('error', { last_error: 'QR encode failed: ' + e.message });
          }
        }
      }

      if (connection === 'open') {
        const user = sock?.user || {};
        const phone = (user.id || '').split(':')[0].split('@')[0];
        setStatus('connected', {
          phone,
          name: user.name || user.verifiedName || '',
          connected_at: nowSec(),
          last_error: '',
        });
        forwardToPanel('whatsapp.connected', { phone, name: user.name || '' });
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'connection closed';
        sock = null;
        if (code === DisconnectReason.loggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
          setStatus('disconnected', { phone: '', name: '', connected_at: 0, last_error: 'logged out' });
          forwardToPanel('whatsapp.disconnected', { reason: 'logged_out' });
        } else if (!stopRequested) {
          setStatus('connecting', { last_error: reason });
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => { startSocket(currentMode).catch(() => {}); }, 3000);
        } else {
          setStatus('disconnected', { last_error: reason });
          forwardToPanel('whatsapp.disconnected', { reason });
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const from = (m.key.remoteJid || '').split('@')[0];
        const text = m.message.conversation || m.message.extendedTextMessage?.text ||
          m.message.imageMessage?.caption || m.message.videoMessage?.caption || '';
        forwardToPanel('message.received', { phone: from, message: text, message_id: m.key.id });
      }
    });

    return sock;
  } catch (e) {
    logger.error({ e: e.message }, 'startSocket failed');
    setStatus('error', { last_error: e.message });
    if (sockReadyResolve) { sockReadyResolve(null); sockReadyResolve = null; }
    return null;
  } finally {
    starting = false;
  }
}

async function disconnectSocket(wipe = true) {
  stopRequested = true;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  if (sock) {
    try { await sock.logout(); }
    catch (_) { try { sock.end(undefined); } catch (_) {} }
    sock = null;
  }
  if (wipe) {
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  setStatus('disconnected', { phone: '', name: '', connected_at: 0, last_error: '' });
}

async function sendOne(payload) {
  if (!sock || state.status !== 'connected') {
    const e = new Error('WhatsApp is not connected'); e.code = 'WHATSAPP_NOT_CONNECTED'; throw e;
  }
  const phone = String(payload.phone || '').replace(/\D/g, '');
  if (!phone) { const e = new Error('Invalid phone number'); e.code = 'INVALID_PHONE'; throw e; }
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
                                 caption: payload.caption || undefined, mimetype: 'application/octet-stream' }; break;
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

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  if (!API_TOKEN) return next();
  const hdr = req.headers['authorization'] || '';
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-connector-token'] || '');
  if (tok !== API_TOKEN)
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Connector token invalid.' } });
  next();
});

const ok   = (res, x = {}) => res.json({ success: true, ...x });
const fail = (res, m, c = 'ERROR', h = 400) =>
  res.status(h).json({ success: false, error: { code: c, message: m } });

app.get('/', (_r, r) => r.json({ service: 'wa-connector', version: '2.1.0', status: state.status }));

app.get('/status', (_r, r) => ok(r, {
  status: state.status,
  phone: state.phone,
  name: state.name,
  connected_at: state.connected_at,
  pairing_code: state.pairing_code,
  pairing_phone: state.pairing_phone,
  last_error: state.last_error,
  has_qr: !!state.qr,
  has_sock: !!sock,
  auth_exists: fs.existsSync(AUTH_DIR),
}));

app.get('/qr', async (_r, r) => {
  if (state.status === 'connected') return ok(r, { status: 'connected' });
  if (state.qr) return ok(r, { status: 'qr', qr: state.qr, expires_at: state.qr_expires_at });
  // No QR yet — kick off socket if idle
  if (!sock && !starting && state.status === 'disconnected') {
    currentMode = 'qr';
    startSocket('qr').catch(() => {});
  }
  ok(r, { status: state.status, qr: '' });
});

app.post('/connect', async (_r, r) => {
  if (state.status === 'connected') return ok(r, { status: 'connected' });
  currentMode = 'qr';
  // If stuck in connecting for too long, reset
  if ((state.status === 'connecting' || state.status === 'starting') && state.started_at && (nowSec() - state.started_at) > 90) {
    logger.warn('stuck connecting — resetting');
    try { await disconnectSocket(true); } catch (_) {}
  }
  if (!sock) startSocket('qr').catch(() => {});
  ok(r, { status: state.status === 'qr' ? 'qr' : 'starting' });
});

app.post('/pair', async (req, res) => {
  const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) {
    return fail(res, 'Enter phone with country code (e.g. 919876543210)', 'INVALID_PHONE', 422);
  }
  if (state.status === 'connected') {
    return fail(res, 'Already connected. Disconnect first.', 'ALREADY_CONNECTED', 409);
  }

  try {
    // Start a FRESH socket in pair mode
    if (sock) {
      stopRequested = true;
      try { sock.end(undefined); } catch (_) {}
      sock = null;
      await new Promise(r => setTimeout(r, 400));
    }
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
    currentMode = 'pair';
    stopRequested = false;

    // Kick off socket creation
    const startPromise = startSocket('pair');

    // Wait for sock to actually be created (not null)
    const readySock = await waitForSock(15000);
    if (!readySock) {
      await startPromise.catch(() => {});
      const s2 = await waitForSock(8000);
      if (!s2) return fail(res, 'Socket failed to start. Check Railway logs.', 'SOCKET_NOT_READY', 500);
      return await requestCode(s2, phone, res);
    }
    return await requestCode(readySock, phone, res);
  } catch (e) {
    logger.error({ e: e.message }, 'pair failed');
    fail(res, e.message || 'Could not generate pairing code', 'PAIR_FAILED', 500);
  }
});

async function requestCode(s, phone, res) {
  try {
    // Baileys requires the socket's WS to be at least opening.
    // Give it a moment if it just got created.
    await new Promise(r => setTimeout(r, 1500));
    if (!s || !s.requestPairingCode) {
      return fail(res, 'Socket missing requestPairingCode — Baileys version mismatch.', 'BAD_SOCKET', 500);
    }
    const code = await s.requestPairingCode(phone);
    state.pairing_code = code;
    state.pairing_phone = phone;
    setStatus('pairing');
    ok(res, { code, status: 'pairing', phone });
  } catch (e) {
    logger.error({ e: e.message }, 'requestPairingCode failed');
    fail(res, e.message || 'Pairing code request failed', 'PAIR_FAILED', 500);
  }
}

app.post('/disconnect', async (_r, r) => {
  try { await disconnectSocket(true); ok(r, { status: 'disconnected' }); }
  catch (e) { fail(r, e.message, 'DISCONNECT_FAILED', 500); }
});

app.post('/reset', async (_r, r) => {
  try {
    stopRequested = true;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    if (sock) { try { sock.end(undefined); } catch (_) {} sock = null; }
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
    setStatus('disconnected', { phone: '', name: '', connected_at: 0, last_error: '' });
    ok(r, { status: 'disconnected', message: 'Auth cleared. Ready for fresh scan.' });
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

(async () => {
  // Always start fresh if no auth exists; otherwise resume
  if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
    logger.info('existing session found — resuming');
    startSocket('qr').catch(() => {});
  } else {
    logger.info('no session — waiting for /connect or /pair');
  }
  app.listen(PORT, HOST, () => logger.info(`wa-connector v2.1.0 listening on http://${HOST}:${PORT}`));
})();

process.on('SIGINT',  async () => { try { await disconnectSocket(false); } catch(_){} process.exit(0); });
process.on('SIGTERM', async () => { try { await disconnectSocket(false); } catch(_){} process.exit(0); });
