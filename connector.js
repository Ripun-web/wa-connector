/**
 * WhatsApp API Connector — Production Ready
 * 
 * Uses @whiskeysockets/baileys for WhatsApp Web multi-device connection.
 * Express API server for PHP admin panel communication.
 * 
 * Endpoints:
 *   GET  /health          — Health check (public)
 *   GET  /status          — Connection status
 *   GET  /qr              — QR code string
 *   GET  /qr-image        — QR code as data URL (PNG)
 *   POST /connect         — Start connection
 *   POST /pair            — Request pairing code
 *   POST /disconnect      — Disconnect WhatsApp
 *   POST /reset           — Reset session (delete auth)
 *   POST /send-message    — Send text message
 *   POST /send-media      — Send media message
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
  delay
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

// ─── Configuration ───────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const API_TOKEN = process.env.API_TOKEN || '';
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SERVICE_VERSION = '1.0.0';

// ─── Logger ──────────────────────────────────────────────────────
const logger = pino({
  level: LOG_LEVEL,
  transport: LOG_LEVEL === 'debug' ? {
    target: 'pino-pretty',
    options: { colorize: true }
  } : undefined,
  redact: {
    paths: ['API_TOKEN', '*.auth', '*.creds', '*.keys'],
    censor: '[REDACTED]'
  }
});

// ─── State ───────────────────────────────────────────────────────
let sock = null;                    // Active Baileys socket
let connectionStatus = 'disconnected'; // disconnected | connecting | qr | connected | logged_out | error
let connectedPhone = null;
let connectedAt = null;
let currentQR = null;
let qrGeneratedAt = null;
let qrExpiresAt = null;
let pairingCode = null;
let lastError = null;
let startTime = Date.now();
let connectLock = false;           // Prevent simultaneous connect calls
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 2000;
const QR_EXPIRY_MS = 60000;        // QR valid for 60 seconds

// ─── Ensure Auth Directory ───────────────────────────────────────
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  logger.info({ authDir: AUTH_DIR }, 'Created auth directory');
}

// ─── Express App ─────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Auth Middleware ─────────────────────────────────────────────
function authMiddleware(req, res, next) {
  // Health endpoint is always public
  if (req.path === '/health') return next();

  if (!API_TOKEN) return next(); // No token configured — skip auth

  const bearer = req.headers['authorization'];
  const tokenHeader = req.headers['x-connector-token'];

  let providedToken = null;
  if (bearer && bearer.startsWith('Bearer ')) {
    providedToken = bearer.slice(7);
  } else if (tokenHeader) {
    providedToken = tokenHeader;
  }

  if (!providedToken || providedToken !== API_TOKEN) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized — invalid or missing API token'
    });
  }

  next();
}

app.use(authMiddleware);

// ─── Helper: JSON Error Response ─────────────────────────────────
function errorResponse(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    error: message
  });
}

// ─── Helper: Clear QR ────────────────────────────────────────────
function clearQR() {
  currentQR = null;
  qrGeneratedAt = null;
  qrExpiresAt = null;
}

// ─── Helper: Sleep ───────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── WhatsApp Connection ─────────────────────────────────────────
async function startWhatsAppConnection() {
  // Prevent multiple simultaneous connections
  if (connectLock) {
    throw new Error('Connection already in progress');
  }

  // Close existing socket if any
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    } catch (e) { /* ignore */ }
    sock = null;
  }

  connectLock = true;
  connectionStatus = 'connecting';
  lastError = null;
  clearQR();
  pairingCode = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    logger.info({ version: version.join('.'), authDir: AUTH_DIR }, 'Starting WhatsApp connection');

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: Browsers.ubuntu('WA Connector'),
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 250
    });

    // ─── Credentials Update ────────────────────────────────────
    sock.ev.on('creds.update', saveCreds);

    // ─── Connection Update ─────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, isNewLogin } = update;

      // ── QR Code Received ────────────────────────────────────
      if (qr) {
        currentQR = qr;
        qrGeneratedAt = Date.now();
        qrExpiresAt = Date.now() + QR_EXPIRY_MS;
        connectionStatus = 'qr';
        pairingCode = null;
        logger.info('QR code generated');
      }

      // ── Connection Open ────────────────────────────────────
      if (connection === 'open') {
        connectionStatus = 'connected';
        connectedPhone = sock.user?.id?.split(':')[0] || sock.user?.id || null;
        connectedAt = new Date().toISOString();
        clearQR();
        pairingCode = null;
        reconnectAttempts = 0;
        logger.info({ phone: connectedPhone }, 'WhatsApp connection opened');
      }

      // ── Connection Close ───────────────────────────────────
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : null;

        const reason = lastDisconnect?.error?.message || 'Unknown reason';

        logger.warn({ statusCode, reason }, 'Connection closed');

        // Determine if we should reconnect
        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          statusCode !== DisconnectReason.badSession &&
          statusCode !== DisconnectReason.connectionReplaced &&
          reconnectAttempts < MAX_RECONNECT_ATTEMPTS;

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = 'logged_out';
          connectedPhone = null;
          connectedAt = null;
          lastError = 'Logged out — session invalidated. Please reset and reconnect.';
          logger.warn('Logged out from WhatsApp — not reconnecting');
        } else if (statusCode === DisconnectReason.badSession) {
          connectionStatus = 'error';
          lastError = 'Bad session — auth files corrupted. Reset required.';
          logger.error('Bad session detected');
        } else if (shouldReconnect) {
          connectionStatus = 'connecting';
          reconnectAttempts++;
          const backoffMs = Math.min(
            RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1),
            30000
          );
          logger.info(
            { attempt: reconnectAttempts, max: MAX_RECONNECT_ATTEMPTS, backoffMs },
            'Scheduling reconnect'
          );
          connectLock = false;
          await sleep(backoffMs);
          try {
            await startWhatsAppConnection();
          } catch (err) {
            logger.error({ err: err.message }, 'Reconnect failed');
            connectionStatus = 'error';
            lastError = `Reconnect failed: ${err.message}`;
          }
          return;
        } else {
          connectionStatus = 'error';
          lastError = `Connection closed: ${reason} (code: ${statusCode})`;
          if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            lastError = 'Max reconnect attempts reached. Please reconnect manually.';
          }
        }

        connectedPhone = null;
        connectedAt = null;
        clearQR();
      }
    });

    connectLock = false;
    return sock;
  } catch (err) {
    connectLock = false;
    connectionStatus = 'error';
    lastError = err.message;
    logger.error({ err: err.message }, 'Failed to start WhatsApp connection');
    throw err;
  }
}

// ─── Express Routes ──────────────────────────────────────────────

// ── GET / ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'wa-connector',
    version: SERVICE_VERSION,
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    endpoints: [
      'GET  /health',
      'GET  /status',
      'GET  /qr',
      'GET  /qr-image',
      'POST /connect',
      'POST /pair',
      'POST /disconnect',
      'POST /reset',
      'POST /send-message',
      'POST /send-media'
    ]
  });
});

// ── GET /health ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'wa-connector',
    version: SERVICE_VERSION,
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString()
  });
});

// ── GET /status ──────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    success: true,
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    phone: connectedPhone,
    connected_at: connectedAt,
    qr_available: !!currentQR,
    qr_expires_at: qrExpiresAt ? new Date(qrExpiresAt).toISOString() : null,
    pairing_code: pairingCode,
    last_error: lastError,
    reconnect_attempts: reconnectAttempts,
    uptime: Math.floor((Date.now() - startTime) / 1000)
  });
});

// ── GET /qr ──────────────────────────────────────────────────────
app.get('/qr', async (req, res) => {
  if (!currentQR) {
    return res.json({
      success: true,
      qr: null,
      message: connectionStatus === 'connected'
        ? 'Already connected — no QR needed'
        : 'No QR available. Call /connect first.'
    });
  }

  // Check expiry
  if (Date.now() > qrExpiresAt) {
    clearQR();
    return res.json({
      success: true,
      qr: null,
      message: 'QR expired. Call /connect to regenerate.'
    });
  }

  res.json({
    success: true,
    qr: currentQR,
    expires_at: new Date(qrExpiresAt).toISOString(),
    expires_in: Math.max(0, Math.floor((qrExpiresAt - Date.now()) / 1000))
  });
});

// ── GET /qr-image ────────────────────────────────────────────────
app.get('/qr-image', async (req, res) => {
  if (!currentQR) {
    return res.status(404).json({
      success: false,
      error: connectionStatus === 'connected'
        ? 'Already connected'
        : 'No QR available. Call /connect first.'
    });
  }

  if (Date.now() > qrExpiresAt) {
    clearQR();
    return res.status(410).json({
      success: false,
      error: 'QR expired. Call /connect to regenerate.'
    });
  }

  try {
    const dataUrl = await QRCode.toDataURL(currentQR, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    res.json({
      success: true,
      image: dataUrl,
      expires_at: new Date(qrExpiresAt).toISOString()
    });
  } catch (err) {
    logger.error({ err: err.message }, 'QR image generation failed');
    errorResponse(res, 500, 'Failed to generate QR image');
  }
});

// ── POST /connect ────────────────────────────────────────────────
app.post('/connect', async (req, res) => {
  if (connectLock) {
    return res.status(409).json({
      success: false,
      error: 'Connection already in progress'
    });
  }

  if (connectionStatus === 'connected') {
    return res.json({
      success: true,
      message: 'Already connected',
      status: connectionStatus,
      phone: connectedPhone
    });
  }

  try {
    await startWhatsAppConnection();
    res.json({
      success: true,
      message: 'Connection started',
      status: connectionStatus
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── POST /pair ───────────────────────────────────────────────────
app.post('/pair', async (req, res) => {
  const { phone } = req.body;

  if (!phone || typeof phone !== 'string') {
    return errorResponse(res, 400, 'Phone number is required');
  }

  // Validate: digits only, with country code
  const cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.length < 7 || cleaned.length > 15) {
    return errorResponse(res, 400, 'Invalid phone number. Include country code, digits only (e.g., 919876543210)');
  }

  if (connectLock) {
    return res.status(409).json({
      success: false,
      error: 'Connection already in progress'
    });
  }

  if (connectionStatus === 'connected') {
    return errorResponse(res, 409, 'Already connected. Disconnect first to pair a new device.');
  }

  try {
    // Start connection (will generate QR but we'll use pairing instead)
    await startWhatsAppConnection();

    if (!sock) {
      return errorResponse(res, 500, 'Socket not initialized');
    }

    // Wait a moment for socket to be ready
    await sleep(1500);

    // Check if already registered
    if (sock.authState?.creds?.registered) {
      return res.json({
        success: true,
        message: 'Already registered — no pairing code needed',
        already_registered: true
      });
    }

    // Request pairing code
    const code = await sock.requestPairingCode(cleaned);
    pairingCode = code;

    logger.info({ phone: cleaned }, 'Pairing code generated');

    res.json({
      success: true,
      pairing_code: code,
      phone: cleaned,
      message: 'Enter this code on your phone: WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number'
    });
  } catch (err) {
    logger.error({ err: err.message, phone: cleaned }, 'Pairing failed');
    errorResponse(res, 500, `Pairing failed: ${err.message}`);
  }
});

// ── POST /disconnect ─────────────────────────────────────────────
app.post('/disconnect', async (req, res) => {
  try {
    if (sock) {
      sock.ev.removeAllListeners();
      try {
        await sock.logout();
      } catch (e) {
        // logout may fail if already disconnected
      }
      try {
        sock.end(undefined);
      } catch (e) { /* ignore */ }
      sock = null;
    }

    connectionStatus = 'disconnected';
    connectedPhone = null;
    connectedAt = null;
    clearQR();
    pairingCode = null;
    lastError = null;
    connectLock = false;

    logger.info('Disconnected manually');

    res.json({
      success: true,
      message: 'Disconnected from WhatsApp'
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Disconnect failed');
    errorResponse(res, 500, err.message);
  }
});

// ── POST /reset ──────────────────────────────────────────────────
app.post('/reset', async (req, res) => {
  try {
    // Disconnect first
    if (sock) {
      sock.ev.removeAllListeners();
      try { await sock.logout(); } catch (e) { /* ignore */ }
      try { sock.end(undefined); } catch (e) { /* ignore */ }
      sock = null;
    }

    // Delete auth directory
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      logger.info({ authDir: AUTH_DIR }, 'Auth directory deleted');
    }

    // Recreate empty auth directory
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    // Reset all state
    connectionStatus = 'disconnected';
    connectedPhone = null;
    connectedAt = null;
    clearQR();
    pairingCode = null;
    lastError = null;
    connectLock = false;
    reconnectAttempts = 0;

    logger.info('Session reset complete');

    res.json({
      success: true,
      message: 'Session reset. You can now connect fresh.'
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Reset failed');
    errorResponse(res, 500, err.message);
  }
});

// ── POST /send-message ───────────────────────────────────────────
app.post('/send-message', async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return errorResponse(res, 400, 'Both "to" and "message" fields are required');
  }

  if (connectionStatus !== 'connected' || !sock) {
    return errorResponse(res, 503, 'WhatsApp is not connected. Connect first.');
  }

  // Format phone number
  const cleaned = to.replace(/[^0-9]/g, '');
  if (cleaned.length < 7 || cleaned.length > 15) {
    return errorResponse(res, 400, 'Invalid phone number. Include country code, digits only.');
  }

  try {
    // WhatsApp JID format: <number>@s.whatsapp.net
    const jid = `${cleaned}@s.whatsapp.net`;

    // Check if number exists on WhatsApp
    const [result] = await sock.onWhatsApp(jid);

    if (!result || !result.exists) {
      return errorResponse(res, 400, `Phone number ${cleaned} is not registered on WhatsApp`);
    }

    const sendResult = await sock.sendMessage(result.jid, { text: message });

    logger.info({ to: cleaned, messageId: sendResult?.key?.id }, 'Message sent');

    res.json({
      success: true,
      message: 'Message sent successfully',
      message_id: sendResult?.key?.id || null,
      to: cleaned,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error({ err: err.message, to: cleaned }, 'Send message failed');
    errorResponse(res, 500, `Failed to send message: ${err.message}`);
  }
});

// ── POST /send-media ─────────────────────────────────────────────
app.post('/send-media', async (req, res) => {
  const { to, type, url, caption, filename } = req.body;

  if (!to || !type || !url) {
    return errorResponse(res, 400, 'Fields "to", "type", and "url" are required');
  }

  const validTypes = ['image', 'video', 'audio', 'document'];
  if (!validTypes.includes(type)) {
    return errorResponse(res, 400, `Invalid type. Must be one of: ${validTypes.join(', ')}`);
  }

  if (connectionStatus !== 'connected' || !sock) {
    return errorResponse(res, 503, 'WhatsApp is not connected. Connect first.');
  }

  const cleaned = to.replace(/[^0-9]/g, '');
  if (cleaned.length < 7 || cleaned.length > 15) {
    return errorResponse(res, 400, 'Invalid phone number. Include country code, digits only.');
  }

  try {
    const jid = `${cleaned}@s.whatsapp.net`;
    const [result] = await sock.onWhatsApp(jid);

    if (!result || !result.exists) {
      return errorResponse(res, 400, `Phone number ${cleaned} is not registered on WhatsApp`);
    }

    const mediaMessage = {};

    switch (type) {
      case 'image':
        mediaMessage.image = { url };
        if (caption) mediaMessage.caption = caption;
        break;
      case 'video':
        mediaMessage.video = { url };
        if (caption) mediaMessage.caption = caption;
        break;
      case 'audio':
        mediaMessage.audio = { url };
        mediaMessage.mimetype = 'audio/mp4';
        mediaMessage.ptt = false;
        break;
      case 'document':
        mediaMessage.document = { url };
        mediaMessage.fileName = filename || 'document';
        mediaMessage.mimetype = 'application/octet-stream';
        if (caption) mediaMessage.caption = caption;
        break;
    }

    const sendResult = await sock.sendMessage(result.jid, mediaMessage);

    logger.info({ to: cleaned, type, messageId: sendResult?.key?.id }, 'Media sent');

    res.json({
      success: true,
      message: `${type} sent successfully`,
      message_id: sendResult?.key?.id || null,
      to: cleaned,
      type,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error({ err: err.message, to: cleaned, type }, 'Send media failed');
    errorResponse(res, 500, `Failed to send ${type}: ${err.message}`);
  }
});

// ─── 404 Handler ─────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// ─── Error Handler ───────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error({ err: err.message, stack: err.stack }, 'Unhandled error');
  if (res.headersSent) return next(err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ─── Start Server ────────────────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
  logger.info(
    { port: PORT, host: HOST, authDir: AUTH_DIR },
    `wa-connector v${SERVICE_VERSION} listening on ${HOST}:${PORT}`
  );
  logger.info('API token protection: ' + (API_TOKEN ? 'ENABLED' : 'DISABLED (set API_TOKEN)'));
});

// ─── Graceful Shutdown ───────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  if (sock) {
    try { sock.end(undefined); } catch (e) { /* ignore */ }
  }
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10000);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down');
  if (sock) {
    try { sock.end(undefined); } catch (e) { /* ignore */ }
  }
  process.exit(0);
});
