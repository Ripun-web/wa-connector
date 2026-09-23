/**
 * WhatsApp Connector — Baileys + Express API
 * Production-ready for Railway / Ubuntu VPS
 *
 * Environment variables:
 *   PORT       — HTTP port (default 3000, Railway sets automatically)
 *   HOST       — Bind address (default 0.0.0.0)
 *   AUTH_DIR   — Persistent auth storage directory (default ./auth_info)
 *   API_TOKEN  — Bearer token for API protection (optional, recommended)
 *   LOG_LEVEL  — Pino log level (default 'info')
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const P = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

/* ──────────────────────────────────────────────
   CONFIGURATION
   ────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_DIR =
  process.env.AUTH_DIR || path.join(__dirname, 'auth_info');
const API_TOKEN = process.env.API_TOKEN || '';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const VERSION = '1.0.0';

// Ensure auth directory exists
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

/* ──────────────────────────────────────────────
   LOGGER (Pino)
   ────────────────────────────────────────────── */
const logger = P({
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard' },
  },
});

/* ──────────────────────────────────────────────
   STATE
   ────────────────────────────────────────────── */
let sock = null;                     // active Baileys socket
let connectionState = 'disconnected'; // disconnected | connecting | qr | connected | logged_out | error
let connectedPhone = null;
let connectedAt = null;
let lastError = null;

let currentQR = null;        // raw QR string from Baileys
let qrDataUrl = null;        // PNG data URL for the browser
let qrExpiresAt = null;      // timestamp when QR expires
const QR_TTL_MS = 60_000;    // QR lives 60 s (WhatsApp rotates ~20 s)

let pairingCode = null;      // last generated pairing code
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let reconnectTimer = null;
let isConnecting = false;    // lock to prevent simultaneous connect calls

/* ──────────────────────────────────────────────
   HELPERS
   ────────────────────────────────────────────── */
function clearQR() {
  currentQR = null;
  qrDataUrl = null;
  qrExpiresAt = null;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function safeLog(...args) {
  // Never log tokens or credentials
  logger.info(...args);
}

/* ──────────────────────────────────────────────
   BAILEYS CONNECTION
   ────────────────────────────────────────────── */
async function connectToWhatsApp() {
  if (isConnecting) {
    logger.warn('Connection already in progress — ignoring duplicate call');
    return;
  }
  isConnecting = true;
  clearReconnectTimer();

  // Tear down any existing socket first
  if (sock) {
    try { sock.end(undefined); } catch (_) {}
    sock = null;
  }

  connectionState = 'connecting';
  lastError = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: P({ level: 'silent' }), // silent Baileys internal logger
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
      },
      browser: ['WaAPI Admin', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: true,
      getMessage: async (key) => {
        // Minimal implementation — Baileys can retry delivery if we return undefined
        return undefined;
      },
    });

    /* ── connection.update ─────────────────────── */
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        qrExpiresAt = Date.now() + QR_TTL_MS;
        try {
          qrDataUrl = await QRCode.toDataURL(qr, {
            width: 280,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
          });
        } catch (qrErr) {
          logger.error({ err: qrErr }, 'Failed to generate QR data URL');
        }
        connectionState = 'qr';
        logger.info('QR code generated');
      }

      if (connection === 'open') {
        connectionState = 'connected';
        connectedPhone = sock.user?.id?.split(':')[0] || sock.user?.id || null;
        connectedAt = new Date().toISOString();
        reconnectAttempts = 0;
        clearQR();
        pairingCode = null;
        logger.info({ phone: connectedPhone }, 'WhatsApp connected');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'unknown';
        logger.warn({ statusCode, reason }, 'Connection closed');

        // Always clean up socket reference
        sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          connectionState = 'logged_out';
          connectedPhone = null;
          connectedAt = null;
          lastError = 'Logged out from WhatsApp';
          clearQR();
          pairingCode = null;
          logger.warn('Logged out — manual re-connect required');
          isConnecting = false;
          return;
        }

        // Any other reason → attempt reconnect with backoff
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(3000 * reconnectAttempts, 30_000);
          logger.info(
            { attempt: reconnectAttempts, delay },
            'Scheduling reconnect'
          );
          connectionState = 'connecting';
          reconnectTimer = setTimeout(() => {
            isConnecting = false;
            connectToWhatsApp();
          }, delay);
        } else {
          connectionState = 'error';
          lastError = 'Max reconnect attempts reached';
          logger.error('Max reconnect attempts reached — giving up');
        }
        isConnecting = false;
        return;
      }
    });

    /* ── creds.update ──────────────────────────── */
    sock.ev.on('creds.update', saveCreds);

    /* ── messages.upsert (optional — for incoming messages) ── */
    sock.ev.on('messages.upsert', async (m) => {
      // Log incoming message metadata only — never log message content by default
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          if (!msg.key.fromMe) {
            logger.info(
              { from: msg.key.remoteJid, id: msg.key.id },
              'Incoming message received'
            );
          }
        }
      }
    });
  } catch (err) {
    logger.error({ err }, 'Failed to create WhatsApp socket');
    connectionState = 'error';
    lastError = err.message || 'Socket creation failed';
    isConnecting = false;
  }
}

/* ──────────────────────────────────────────────
   EXPRESS APP
   ────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '2mb' }));

/* ── CORS — only if you need direct browser access ──
   Recommended architecture: PHP server → Node connector.
   If you access the connector directly from a browser on a
   different origin, uncomment and restrict the origin.
*/
// app.use((req, res, next) => {
//   res.header('Access-Control-Allow-Origin', 'https://your-php-domain.com');
//   res.header('Access-Control-Allow-Headers', 'Authorization, x-connector-token, Content-Type');
//   res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
//   if (req.method === 'OPTIONS') return res.sendStatus(204);
//   next();
// });

/* ──────────────────────────────────────────────
   AUTH MIDDLEWARE
   ────────────────────────────────────────────── */
function requireAuth(req, res, next) {
  if (!API_TOKEN) return next(); // token not configured → open

  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  const headerToken = req.headers['x-connector-token'];

  if (bearerToken === API_TOKEN || headerToken === API_TOKEN) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized — invalid or missing API token',
  });
}

/* ──────────────────────────────────────────────
   ROUTES
   ────────────────────────────────────────────── */

/* GET / — info page */
app.get('/', (req, res) => {
  res.json({
    service: 'wa-connector',
    version: VERSION,
    status: connectionState,
    connected: connectionState === 'connected',
    docs: 'See /health and /status for details',
  });
});

/* GET /health — public health check */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'wa-connector',
    version: VERSION,
    status: connectionState,
    connected: connectionState === 'connected',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/* GET /status — protected status */
app.get('/status', requireAuth, (req, res) => {
  res.json({
    success: true,
    status: connectionState,
    connected: connectionState === 'connected',
    phone: connectedPhone,
    connected_at: connectedAt,
    qr_available: !!qrDataUrl,
    qr_expires_at: qrExpiresAt ? new Date(qrExpiresAt).toISOString() : null,
    pairing_code: pairingCode,
    last_error: lastError,
  });
});

/* POST /connect — start connection */
app.post('/connect', requireAuth, async (req, res) => {
  if (connectionState === 'connected') {
    return res.status(409).json({
      success: false,
      error: 'Already connected to WhatsApp',
    });
  }
  if (isConnecting) {
    return res.status(409).json({
      success: false,
      error: 'Connection already in progress',
    });
  }

  isConnecting = false; // allow the connect call to proceed
  connectToWhatsApp();  // async — response returns immediately

  res.json({
    success: true,
    message: 'Connection started — poll /status for QR or connected state',
  });
});

/* POST /disconnect — disconnect current session (keeps auth files) */
app.post('/disconnect', requireAuth, async (req, res) => {
  clearReconnectTimer();
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // prevent auto-reconnect

  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      logger.warn({ err: e }, 'sock.logout() failed — forcing end');
      try { sock.end(undefined); } catch (_) {}
    }
    sock = null;
  }

  connectionState = 'disconnected';
  connectedPhone = null;
  connectedAt = null;
  clearQR();
  pairingCode = null;
  lastError = null;

  logger.info('Disconnected by admin');
  res.json({ success: true, message: 'Disconnected' });
});

/* POST /reset — wipe auth directory and restart */
app.post('/reset', requireAuth, async (req, res) => {
  clearReconnectTimer();
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS;

  if (sock) {
    try { sock.end(undefined); } catch (_) {}
    sock = null;
  }

  // Wipe auth directory
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch (e) {
    logger.error({ err: e }, 'Failed to wipe auth directory');
    return res.status(500).json({
      success: false,
      error: 'Failed to reset auth directory: ' + e.message,
    });
  }

  connectionState = 'disconnected';
  connectedPhone = null;
  connectedAt = null;
  clearQR();
  pairingCode = null;
  lastError = null;

  logger.info('Session reset — auth directory wiped');
  res.json({
    success: true,
    message: 'Session reset — scan QR or use pairing code to reconnect',
  });
});

/* GET /qr — return QR string + data URL */
app.get('/qr', requireAuth, (req, res) => {
  if (!currentQR) {
    return res.status(404).json({
      success: false,
      error: 'No QR available — connect first or connection may already be established',
    });
  }
  res.json({
    success: true,
    qr: currentQR,
    qr_image: qrDataUrl,
    expires_at: qrExpiresAt ? new Date(qrExpiresAt).toISOString() : null,
  });
});

/* GET /qr-image — return only the PNG data URL */
app.get('/qr-image', requireAuth, (req, res) => {
  if (!qrDataUrl) {
    return res.status(404).json({
      success: false,
      error: 'No QR image available',
    });
  }
  res.json({ success: true, qr_image: qrDataUrl });
});

/* POST /pair — request pairing code */
app.post('/pair', requireAuth, async (req, res) => {
  const { phone } = req.body || {};

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Missing "phone" field — include country code, digits only (e.g. 919876543210)',
    });
  }

  // Validate: digits only, no +, (), -, or spaces
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length < 8 || cleaned.length > 15) {
    return res.status(400).json({
      success: false,
      error: 'Invalid phone number — must be 8–15 digits with country code',
    });
  }

  if (!sock || !sock.authState) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp socket not initialised — call /connect first',
    });
  }

  if (sock.authState.creds.registered) {
    return res.status(409).json({
      success: false,
      error: 'This device is already registered — disconnect/reset first',
    });
  }

  try {
    const code = await sock.requestPairingCode(cleaned);
    pairingCode = code;
    logger.info({ phone: cleaned }, 'Pairing code generated');
    res.json({
      success: true,
      pairing_code: code,
      phone: cleaned,
      instructions:
        'On your phone: WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead, then enter the code.',
    });
  } catch (err) {
    logger.error({ err }, 'Pairing code request failed');
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to generate pairing code',
    });
  }
});

/* POST /send-message — send text */
app.post('/send-message', requireAuth, async (req, res) => {
  const { to, message } = req.body || {};

  if (!to || !message) {
    return res.status(400).json({
      success: false,
      error: 'Missing "to" or "message" field',
    });
  }

  if (connectionState !== 'connected' || !sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp is not connected',
    });
  }

  try {
    const jid = to.includes('@s.whatsapp.net')
      ? to
      : `${to.replace(/\D/g, '')}@s.whatsapp.net`;

    const result = await sock.sendMessage(jid, { text: message });

    res.json({
      success: true,
      message_id: result?.key?.id || null,
      to: jid,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, to }, 'Failed to send message');
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to send message',
    });
  }
});

/* POST /send-media — send image / video / audio / document */
app.post('/send-media', requireAuth, async (req, res) => {
  const { to, type, url, caption, filename } = req.body || {};

  if (!to || !type || !url) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: "to", "type", "url"',
    });
  }

  const allowedTypes = ['image', 'video', 'audio', 'document'];
  if (!allowedTypes.includes(type)) {
    return res.status(400).json({
      success: false,
      error: `Unsupported media type "${type}". Allowed: ${allowedTypes.join(', ')}`,
    });
  }

  if (connectionState !== 'connected' || !sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp is not connected',
    });
  }

  try {
    const jid = to.includes('@s.whatsapp.net')
      ? to
      : `${to.replace(/\D/g, '')}@s.whatsapp.net`;

    let payload;

    switch (type) {
      case 'image':
        payload = { image: { url }, caption: caption || undefined };
        break;
      case 'video':
        payload = { video: { url }, caption: caption || undefined };
        break;
      case 'audio':
        payload = { audio: { url }, mimetype: 'audio/mp4' };
        break;
      case 'document':
        payload = {
          document: { url },
          fileName: filename || 'file',
          mimetype: 'application/octet-stream',
          caption: caption || undefined,
        };
        break;
      default:
        return res.status(400).json({
          success: false,
          error: 'Unsupported media type',
        });
    }

    const result = await sock.sendMessage(jid, payload);

    res.json({
      success: true,
      message_id: result?.key?.id || null,
      to: jid,
      type,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, to, type }, 'Failed to send media');
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to send media',
    });
  }
});

/* ── 404 JSON handler for all unmatched routes ── */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

/* ── Global error handler ── */
app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled server error');
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

/* ──────────────────────────────────────────────
   START SERVER
   ────────────────────────────────────────────── */
const server = app.listen(PORT, HOST, () => {
  logger.info(`wa-connector v${VERSION} listening on ${HOST}:${PORT}`);
  logger.info(`Auth directory: ${AUTH_DIR}`);
  logger.info(`API token protection: ${API_TOKEN ? 'ENABLED' : 'DISABLED'}`);

  // Auto-connect on startup if credentials already exist
  const hasCreds = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
  if (hasCreds) {
    logger.info('Existing credentials found — auto-connecting');
    connectToWhatsApp();
  } else {
    logger.info('No credentials found — waiting for /connect');
  }
});

/* ── Graceful shutdown ── */
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  clearReconnectTimer();
  if (sock) {
    try { sock.end(undefined); } catch (_) {}
  }
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  // Force exit after 5 s
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});

module.exports = app;
