'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pino = require('pino');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, jidNormalizedUser, delay } = require('@whiskeysockets/baileys');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OTP_LENGTH = 6;
const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000);
const OTP_COOLDOWN_MS = Number(process.env.OTP_COOLDOWN_MS || 60 * 1000);
const OTP_MAX_PER_HOUR = Number(process.env.OTP_MAX_PER_HOUR || 5);
const OTP_MAX_VERIFY_ATTEMPTS = Number(process.env.OTP_MAX_VERIFY_ATTEMPTS || 5);
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 3000);
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const QR_FILE = path.join(DATA_DIR, 'qr.png');

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
app.use(express.json({ limit: process.env.JSON_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: false, limit: process.env.JSON_LIMIT || '1mb' }));

let sock = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastSendAt = 0;
let qr = null;
let qrExpiresAt = 0;
const otpStore = new Map();

function normalizePhone(value) {
  let n = String(value || '').replace(/\D/g, '');
  if (n.length === 10 && (process.env.DEFAULT_COUNTRY || 'IN') === 'IN') n = '91' + n;
  return n;
}
function jid(phone) { return jidNormalizedUser(`${normalizePhone(phone)}@s.whatsapp.net`); }
function randomOtp() { return crypto.randomInt(0, 1000000).toString().padStart(OTP_LENGTH, '0'); }
function cleanupOtps() {
  const now = Date.now();
  for (const [phone, item] of otpStore) {
    item.history = item.history.filter(t => now - t < 60 * 60 * 1000);
    if (item.expiresAt < now && item.history.length === 0) otpStore.delete(phone);
  }
}
function canRequestOtp(phone) {
  cleanupOtps();
  const item = otpStore.get(phone);
  if (!item) return { ok: true };
  const now = Date.now();
  if (item.lastSentAt && now - item.lastSentAt < OTP_COOLDOWN_MS) {
    return { ok: false, error: `Please wait ${Math.ceil((OTP_COOLDOWN_MS - (now - item.lastSentAt)) / 1000)} seconds before requesting another OTP.` };
  }
  if (item.history.length >= OTP_MAX_PER_HOUR) return { ok: false, error: 'OTP hourly limit reached for this number.' };
  return { ok: true };
}
async function sendText(phone, text) {
  if (!sock) throw new Error('WhatsApp is not connected');
  const elapsed = Date.now() - lastSendAt;
  if (elapsed < SEND_DELAY_MS) await delay(SEND_DELAY_MS - elapsed);
  await sock.sendMessage(jid(phone), { text });
  lastSendAt = Date.now();
}
async function makeQR(value) {
  qr = value;
  qrExpiresAt = Date.now() + 5 * 60 * 1000;
  try { await qrcode.toFile(QR_FILE, value, { width: 600, margin: 2 }); } catch (e) { logger.warn({ err: e.message }, 'QR file generation failed'); }
}
function clearQR() {
  qr = null;
  qrExpiresAt = 0;
  try { if (fs.existsSync(QR_FILE)) fs.unlinkSync(QR_FILE); } catch {}
}
async function connect() {
  if (sock) return;
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('RB WhatsApp Connector'), markOnlineOnConnect: false, generateHighQualityLinkPreview: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr: nextQr }) => {
    if (nextQr) await makeQR(nextQr);
    if (connection === 'open') { reconnectAttempts = 0; clearQR(); logger.info('WhatsApp connected'); }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      sock = null;
      if (code !== DisconnectReason.loggedOut) {
        reconnectAttempts++;
        const wait = Math.min(30000, 1000 * Math.max(1, reconnectAttempts));
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connect().catch(e => logger.error({ err: e.message }, 'Reconnect failed')), wait);
      } else clearQR();
    }
  });
}

app.get('/', (req, res) => res.json({ name: 'RB WhatsApp Connector', version: '6.1.0', features: ['QR connection', 'OTP service', 'send message', 'health/status', 'automatic reconnect'], auth: 'No API key required', note: 'Use only for legitimate, consented messaging. No software can guarantee that a WhatsApp account will never be banned.' }));
app.get('/health', (req, res) => res.json({ success: true, service: 'rb-wa-connector', connected: !!sock, uptime: process.uptime() }));
app.get('/status', (req, res) => res.json({ success: true, connected: !!sock, qrAvailable: !!qr && qrExpiresAt > Date.now(), qrExpiresAt: qrExpiresAt || null, reconnectAttempts }));
app.get('/qr', (req, res) => { if (!qr || qrExpiresAt <= Date.now()) return res.status(404).json({ success: false, error: 'QR not available' }); res.type('text/plain').send(qr); });
app.get('/qr.png', (req, res) => { if (!fs.existsSync(QR_FILE) || qrExpiresAt <= Date.now()) return res.status(404).json({ success: false, error: 'QR not available' }); res.sendFile(QR_FILE); });
app.post('/connect', async (req, res) => { try { await connect(); res.json({ success: true, message: 'Connection started. Scan the QR from /qr.png when available.' }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
app.post('/send-message', async (req, res) => {
  const phone = normalizePhone(req.body.phone); const text = String(req.body.message || '').trim();
  if (!phone || !text) return res.status(400).json({ success: false, error: 'phone and message are required' });
  try { await sendText(phone, text); res.json({ success: true, phone }); } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

async function requestOtp(req, res) {
  const phone = normalizePhone(req.body.phone);
  if (!phone || phone.length < 10) return res.status(400).json({ success: false, error: 'Valid phone number is required' });
  const limit = canRequestOtp(phone);
  if (!limit.ok) return res.status(429).json({ success: false, error: limit.error });
  const code = randomOtp(); const now = Date.now();
  const item = otpStore.get(phone) || { history: [], verifyAttempts: 0 };
  item.codeHash = crypto.createHash('sha256').update(code).digest('hex');
  item.expiresAt = now + OTP_TTL_MS; item.lastSentAt = now; item.verifyAttempts = 0; item.history.push(now); otpStore.set(phone, item);
  try {
    await sendText(phone, `Your verification OTP is ${code}. It expires in ${Math.ceil(OTP_TTL_MS / 60000)} minutes. Do not share this code.`);
    res.json({ success: true, message: 'OTP sent successfully', expiresIn: OTP_TTL_MS / 1000 });
  } catch (e) { item.history.pop(); otpStore.set(phone, item); res.status(400).json({ success: false, error: e.message }); }
}
function verifyOtp(req, res) {
  const phone = normalizePhone(req.body.phone); const code = String(req.body.otp || '').trim(); const item = otpStore.get(phone);
  if (!item || !item.codeHash || Date.now() > item.expiresAt) return res.status(400).json({ success: false, verified: false, error: 'OTP expired or not found' });
  if (item.verifyAttempts >= OTP_MAX_VERIFY_ATTEMPTS) { otpStore.delete(phone); return res.status(429).json({ success: false, verified: false, error: 'Too many verification attempts. Request a new OTP.' }); }
  item.verifyAttempts++;
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  const valid = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(item.codeHash));
  if (!valid) { otpStore.set(phone, item); return res.status(400).json({ success: false, verified: false, error: 'Invalid OTP' }); }
  otpStore.delete(phone); res.json({ success: true, verified: true });
}
app.post('/otp/request', requestOtp);
app.post('/send-otp', requestOtp);
app.post('/otp/verify', verifyOtp);
app.post('/verify-otp', verifyOtp);
app.post('/disconnect', async (req, res) => { try { if (sock) await sock.logout(); } catch {} sock = null; clearQR(); res.json({ success: true, message: 'Disconnected' }); });

app.listen(PORT, () => logger.info(`RB WhatsApp Connector listening on port ${PORT}`));
connect().catch(e => logger.error({ err: e.message }, 'Initial connection failed'));
process.on('SIGTERM', () => { try { sock?.end?.(new Error('SIGTERM')); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { sock?.end?.(new Error('SIGINT')); } catch {} process.exit(0); });
