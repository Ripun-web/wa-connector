
'use strict';

/*
 * ============================================================
 * WhatsApp Connector
 * Baileys + Express
 *
 * Features:
 *  - QR login
 *  - Pairing-code login
 *  - Persistent auth session
 *  - Automatic reconnect
 *  - QR refresh
 *  - Pairing-code protection
 *  - Webhook events
 *  - REST API
 *  - Message sending
 *  - Watchdog
 *  - Graceful shutdown
 *
 * Requirements:
 *   Node.js 20+
 *
 * Install:
 *   npm install express qrcode pino @hapi/boom @whiskeysockets/baileys
 *
 * Start:
 *   node connector.js
 *
 * ============================================================
 */

const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');

/* ============================================================
 * CONFIG
 * ============================================================
 */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const AUTH_DIR =
  process.env.AUTH_DIR ||
  path.join(__dirname, 'auth_info');

const API_TOKEN =
  process.env.API_TOKEN || '';

const PANEL_HOOK =
  process.env.PANEL_WEBHOOK_URL || '';

const HOOK_SECRET =
  process.env.PANEL_WEBHOOK_SECRET || '';

const LOG_LEVEL =
  process.env.LOG_LEVEL || 'info';

const QR_TTL_SECONDS =
  Number(process.env.QR_TTL_SECONDS || 60);

const RECONNECT_DELAY =
  Number(process.env.RECONNECT_DELAY || 3000);

const CONNECT_TIMEOUT =
  Number(process.env.CONNECT_TIMEOUT || 60000);

const WATCHDOG_INTERVAL =
  Number(process.env.WATCHDOG_INTERVAL || 5000);

const CONNECTING_TIMEOUT =
  Number(process.env.CONNECTING_TIMEOUT || 45000);

/* ============================================================
 * LOGGER
 * ============================================================
 */

const logger = pino({
  level: LOG_LEVEL,
});

/* ============================================================
 * HELPERS
 * ============================================================
 */

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeString(value) {
  return value == null ? '' : String(value);
}

function cleanPhone(value) {
  return safeString(value).replace(/\D/g, '');
}

function jidFromPhone(phone) {
  const clean = cleanPhone(phone);
  return clean
    ? `${clean}@s.whatsapp.net`
    : null;
}

function getDisconnectCode(error) {
  try {
    if (!error) return undefined;

    if (error instanceof Boom) {
      return error.output?.statusCode;
    }

    if (error.output?.statusCode) {
      return error.output.statusCode;
    }

    if (error.data?.statusCode) {
      return error.data.statusCode;
    }

    return undefined;
  } catch (_) {
    return undefined;
  }
}

function getErrorMessage(error) {
  if (!error) return 'Unknown error';

  if (typeof error === 'string') {
    return error;
  }

  return (
    error.message ||
    error.data?.message ||
    error.output?.payload?.message ||
    'Unknown error'
  );
}

/* ============================================================
 * GLOBAL STATE
 * ============================================================
 */

const state = {
  status: 'disconnected',

  phone: '',
  name: '',

  connected_at: 0,

  qr: '',
  qr_expires_at: 0,

  pairing_code: '',
  pairing_phone: '',

  last_error: '',

  mode: '',

  reconnect_count: 0,

  last_change: nowMs(),

  last_qr_at: 0,

  socket_generation: 0,
};

/* ============================================================
 * SOCKET CONTROL
 * ============================================================
 */

let sock = null;

let starting = false;

let stopRequested = false;

let reconnectTimer = null;

let watchdogTimer = null;

let pairingRequested = false;

let currentStartPromise = null;

/*
 * Each socket gets a generation number.
 * This prevents old sockets from modifying state
 * after a new socket has already started.
 */

function nextGeneration() {
  state.socket_generation += 1;
  return state.socket_generation;
}

/* ============================================================
 * STATUS
 * ============================================================
 */

function setStatus(status, extra = {}) {
  state.status = status;

  Object.assign(state, extra);

  state.last_change = nowMs();

  if (status !== 'qr') {
    state.qr = '';
    state.qr_expires_at = 0;
  }

  if (status !== 'pairing') {
    state.pairing_code = '';
  }

  logger.info(
    {
      status: state.status,
      phone: state.phone,
      mode: state.mode,
      generation: state.socket_generation,
    },
    'connector state changed'
  );
}

/* ============================================================
 * WEBHOOK
 * ============================================================
 */

async function forwardToPanel(event, data = {}) {
  if (!PANEL_HOOK) {
    return;
  }

  try {
    const payload = {
      event,
      timestamp: nowSec(),
      data,
    };

    const body = JSON.stringify(payload);

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'WA-Connector/3.0',
    };

    if (HOOK_SECRET) {
      headers['X-Webhook-Signature'] =
        crypto
          .createHmac('sha256', HOOK_SECRET)
          .update(body)
          .digest('hex');
    }

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 10000);

    try {
      const response = await fetch(PANEL_HOOK, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn(
          {
            status: response.status,
            event,
          },
          'panel webhook returned non-2xx'
        );
      }
    } finally {
      clearTimeout(timeout);
    }

  } catch (error) {
    logger.warn(
      {
        error: getErrorMessage(error),
        event,
      },
      'panel webhook failed'
    );
  }
}

/* ============================================================
 * AUTH DIRECTORY
 * ============================================================
 */

function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, {
      recursive: true,
    });
  }
}

function authExists() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      return false;
    }

    const files = fs.readdirSync(AUTH_DIR);

    return files.some(file =>
      file === 'creds.json' ||
      file.startsWith('creds')
    );

  } catch (_) {
    return false;
  }
}

function removeAuth() {
  try {
    fs.rmSync(AUTH_DIR, {
      recursive: true,
      force: true,
    });

    logger.info('auth directory removed');

  } catch (error) {
    logger.warn(
      {
        error: getErrorMessage(error),
      },
      'failed removing auth directory'
    );
  }
}

/* ============================================================
 * SOCKET TEARDOWN
 * ============================================================
 */

async function teardownSocket() {
  const oldSocket = sock;

  sock = null;

  if (!oldSocket) {
    return;
  }

  try {
    oldSocket.ev.removeAllListeners();
  } catch (_) {}

  try {
    oldSocket.ws?.close();
  } catch (_) {}

  try {
    oldSocket.end?.(undefined);
  } catch (_) {}

  await sleep(100);
}

/* ============================================================
 * QR HANDLER
 * ============================================================
 */

async function handleQR(qrString, generation) {
  if (!qrString) {
    return;
  }

  /*
   * Ignore QR emitted by an old socket.
   */

  if (generation !== state.socket_generation) {
    return;
  }

  /*
   * Pairing mode should not expose QR as the primary method.
   */

  if (state.mode !== 'qr') {
    return;
  }

  try {
    const dataUrl = await QRCode.toDataURL(qrString, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
    });

    if (generation !== state.socket_generation) {
      return;
    }

    state.qr = dataUrl;

    state.qr_expires_at =
      nowSec() + QR_TTL_SECONDS;

    state.last_qr_at = nowMs();

    setStatus('qr');

    await forwardToPanel(
      'whatsapp.qr',
      {
        expires_at: state.qr_expires_at,
      }
    );

    logger.info(
      {
        expires_at: state.qr_expires_at,
      },
      'new QR generated'
    );

  } catch (error) {
    logger.error(
      {
        error: getErrorMessage(error),
      },
      'QR generation failed'
    );

    state.last_error =
      getErrorMessage(error);
  }
}

/* ============================================================
 * PAIRING CODE
 * ============================================================
 */

async function requestPairingCode(
  socket,
  phone,
  generation
) {
  if (!phone) {
    throw new Error(
      'Phone number is required'
    );
  }

  if (generation !== state.socket_generation) {
    throw new Error(
      'Socket generation changed'
    );
  }

  if (socket !== sock) {
    throw new Error(
      'Socket is no longer active'
    );
  }

  /*
   * Already authenticated?
   */

  if (
    socket.authState &&
    socket.authState.creds &&
    socket.authState.creds.registered
  ) {
    logger.info(
      'pairing skipped because credentials are already registered'
    );

    return null;
  }

  /*
   * Prevent duplicate pairing requests.
   */

  if (pairingRequested) {
    return state.pairing_code || null;
  }

  pairingRequested = true;

  try {
    /*
     * Baileys pairing requires international digits only.
     *
     * Example:
     * India:
     * 919876543210
     */

    const normalized = cleanPhone(phone);

    if (
      normalized.length < 8 ||
      normalized.length > 15
    ) {
      throw new Error(
        'Invalid international phone number'
      );
    }

    logger.info(
      {
        phone: normalized,
      },
      'requesting WhatsApp pairing code'
    );

    /*
     * Give the socket a little time to enter
     * the connecting state.
     */

    await sleep(1200);

    if (generation !== state.socket_generation) {
      throw new Error(
        'Socket changed before pairing'
      );
    }

    if (socket !== sock) {
      throw new Error(
        'Socket changed before pairing'
      );
    }

    const code =
      await socket.requestPairingCode(
        normalized
      );

    if (!code) {
      throw new Error(
        'WhatsApp returned an empty pairing code'
      );
    }

    state.pairing_phone = normalized;

    state.pairing_code =
      String(code).replace(
        /(.{4})/g,
        '$1-'
      ).replace(/-$/, '');

    state.qr = '';
    state.qr_expires_at = 0;

    setStatus('pairing');

    await forwardToPanel(
      'whatsapp.pairing_code',
      {
        phone: normalized,
        code: state.pairing_code,
      }
    );

    logger.info(
      {
        phone: normalized,
        code: state.pairing_code,
      },
      'pairing code generated'
    );

    return state.pairing_code;

  } finally {
    pairingRequested = false;
  }
}

/* ============================================================
 * START SOCKET
 * ============================================================
 */

async function startSocket(
  mode = 'qr',
  pairingPhone = ''
) {
  /*
   * If another start operation is already running,
   * return that same promise.
   */

  if (starting && currentStartPromise) {
    return currentStartPromise;
  }

  currentStartPromise =
    startSocketInternal(
      mode,
      pairingPhone
    );

  try {
    return await currentStartPromise;
  } finally {
    currentStartPromise = null;
  }
}

async function startSocketInternal(
  mode = 'qr',
  pairingPhone = ''
) {
  starting = true;
  stopRequested = false;
  pairingRequested = false;

  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const generation =
    nextGeneration();

  state.mode = mode;

  /*
   * Clear old login UI.
   */

  state.qr = '';
  state.qr_expires_at = 0;
  state.pairing_code = '';

  try {
    ensureAuthDir();

    /*
     * Close previous socket.
     */

    await teardownSocket();

    /*
     * Load auth.
     */

    const {
      state: authState,
      saveCreds,
    } = await useMultiFileAuthState(
      AUTH_DIR
    );

    /*
     * Get current WhatsApp Web version.
     *
     * If fetching the version fails, we continue
     * with the library default instead of killing
     * the connector immediately.
     */

    let version;

    try {
      const latest =
        await fetchLatestBaileysVersion();

      version = latest?.version;

      logger.info(
        {
          version,
          isLatest: latest?.isLatest,
        },
        'WhatsApp Web version loaded'
      );

    } catch (error) {
      logger.warn(
        {
          error: getErrorMessage(error),
        },
        'failed to fetch latest WA version; using library default'
      );
    }

    setStatus('connecting', {
      last_error: '',
    });

    /*
     * Socket configuration.
     *
     * printQRInTerminal intentionally omitted because
     * it is deprecated in current Baileys.
     */

    const socketConfig = {
      auth: authState,

      logger: pino({
        level: 'silent',
      }),

      browser:
        Browsers.windows('WA Connector'),

      markOnlineOnConnect: false,

      syncFullHistory: false,

      connectTimeoutMs:
        CONNECT_TIMEOUT,

      qrTimeout:
        60000,

      generateHighQualityLinkPreview:
        false,

      shouldIgnoreJid: jid => {
        return jid === 'status@broadcast';
      },
    };

    if (version) {
      socketConfig.version = version;
    }

    const created =
      makeWASocket(socketConfig);

    sock = created;

    /*
     * Store the socket generation.
     */

    created.__generation =
      generation;

    /*
     * Save credentials.
     */

    created.ev.on(
      'creds.update',
      async () => {
        try {
          await saveCreds();
        } catch (error) {
          logger.error(
            {
              error: getErrorMessage(error),
            },
            'failed saving credentials'
          );
        }
      }
    );

    /*
     * CONNECTION UPDATE
     */

    created.ev.on(
      'connection.update',
      async update => {
        /*
         * Ignore events from old sockets.
         */

        if (
          generation !==
          state.socket_generation
        ) {
          return;
        }

        const {
          connection,
          lastDisconnect,
          qr,
          isNewLogin,
        } = update || {};

        /*
         * Debug useful during installation.
         */

        logger.debug(
          {
            connection,
            hasQr: Boolean(qr),
            isNewLogin,
            generation,
          },
          'connection.update'
        );

        /*
         * QR
         */

        if (qr) {
          await handleQR(
            qr,
            generation
          );
        }

        /*
         * CONNECTED
         */

        if (connection === 'open') {
          if (
            generation !==
            state.socket_generation
          ) {
            return;
          }

          const user =
            created.user || {};

          const rawId =
            user.id || '';

          const phone =
            rawId
              .split(':')[0]
              .split('@')[0];

          const name =
            user.name ||
            user.verifiedName ||
            '';

          state.reconnect_count = 0;

          setStatus(
            'connected',
            {
              phone,
              name,
              connected_at:
                nowSec(),
              last_error: '',
              mode: '',
              pairing_code: '',
              pairing_phone:
                state.pairing_phone,
            }
          );

          state.qr = '';
          state.qr_expires_at = 0;

          logger.info(
            {
              phone,
              name,
            },
            'WhatsApp connected'
          );

          await forwardToPanel(
            'whatsapp.connected',
            {
              phone,
              name,
              is_new_login:
                Boolean(isNewLogin),
            }
          );

          return;
        }

        /*
         * CONNECTION CLOSED
         */

        if (connection === 'close') {
          const code =
            getDisconnectCode(
              lastDisconnect?.error
            );

          const reason =
            getErrorMessage(
              lastDisconnect?.error
            ) ||
            'connection closed';

          logger.warn(
            {
              code,
              reason,
              generation,
            },
            'WhatsApp connection closed'
          );

          /*
           * Only the active socket may change
           * global socket state.
           */

          if (
            generation ===
            state.socket_generation
          ) {
            sock = null;
          }

          /*
           * Logged out.
           */

          if (
            code ===
            DisconnectReason.loggedOut
          ) {
            logger.warn(
              'WhatsApp session logged out'
            );

            removeAuth();

            state.phone = '';
            state.name = '';
            state.connected_at = 0;

            setStatus(
              'disconnected',
              {
                last_error:
                  'logged out',
                mode: '',
              }
            );

            await forwardToPanel(
              'whatsapp.disconnected',
              {
                reason:
                  'logged_out',
                code,
              }
            );

            return;
          }

          /*
           * Restart requested by application.
           */

          if (stopRequested) {
            setStatus(
              'disconnected',
              {
                last_error:
                  reason,
                mode: '',
              }
            );

            await forwardToPanel(
              'whatsapp.disconnected',
              {
                reason,
                code,
              }
            );

            return;
          }

          /*
           * Any other disconnect:
           * reconnect automatically.
           */

          state.reconnect_count += 1;

          setStatus(
            'connecting',
            {
              last_error:
                reason,
            }
          );

          scheduleReconnect(
            state.mode ||
            'qr'
          );
        }
      }
    );

    /*
     * MESSAGES
     */

    created.ev.on(
      'messages.upsert',
      async event => {
        if (
          generation !==
          state.socket_generation
        ) {
          return;
        }

        const {
          messages,
          type,
        } = event || {};

        if (type !== 'notify') {
          return;
        }

        for (const message of messages || []) {
          try {
            if (!message?.message) {
              continue;
            }

            if (message.key?.fromMe) {
              continue;
            }

            const remoteJid =
              message.key?.remoteJid ||
              '';

            const from =
              remoteJid.split('@')[0];

            const text =
              extractMessageText(
                message
              );

            await forwardToPanel(
              'message.received',
              {
                phone: from,
                jid: remoteJid,
                message: text,
                message_id:
                  message.key?.id || '',
                push_name:
                  message.pushName || '',
                timestamp:
                  message.messageTimestamp ||
                  nowSec(),
              }
            );

          } catch (error) {
            logger.warn(
              {
                error:
                  getErrorMessage(error),
              },
              'message handler failed'
            );
          }
        }
      }
    );

    /*
     * PAIRING CODE
     *
     * Current Baileys documentation uses
     * requestPairingCode() on an unregistered socket.
     */

    if (
      mode === 'pair' &&
      pairingPhone &&
      !authState.creds.registered
    ) {
      /*
       * Wait for the socket to start.
       */

      await sleep(1200);

      if (
        generation !==
        state.socket_generation
      ) {
        throw new Error(
          'Socket generation changed'
        );
      }

      if (sock !== created) {
        throw new Error(
          'Socket is no longer active'
        );
      }

      await requestPairingCode(
        created,
        pairingPhone,
        generation
      );
    }

    return created;

  } catch (error) {
    logger.error(
      {
        error:
          getErrorMessage(error),
        stack:
          error?.stack,
      },
      'startSocket failed'
    );

    if (
      generation ===
      state.socket_generation
    ) {
      setStatus(
        'error',
        {
          last_error:
            getErrorMessage(error),
        }
      );
    }

    throw error;

  } finally {
    starting = false;
  }
}

/* ============================================================
 * RECONNECT
 * ============================================================
 */

function scheduleReconnect(
  mode = 'qr'
) {
  if (stopRequested) {
    return;
  }

  if (reconnectTimer) {
    return;
  }

  const delay =
    Math.min(
      RECONNECT_DELAY *
        Math.max(
          1,
          Math.min(
            state.reconnect_count,
            5
          )
        ),
      15000
    );

  logger.info(
    {
      delay,
      mode,
    },
    'reconnect scheduled'
  );

  reconnectTimer =
    setTimeout(
      async () => {
        reconnectTimer = null;

        if (stopRequested) {
          return;
        }

        try {
          await startSocket(
            mode
          );
        } catch (error) {
          logger.warn(
            {
              error:
                getErrorMessage(error),
            },
            'reconnect failed'
          );

          scheduleReconnect(
            mode
          );
        }
      },
      delay
    );
}

/* ============================================================
 * DISCONNECT
 * ============================================================
 */

async function disconnectSocket(
  removeSession = true
) {
  stopRequested = true;

  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  pairingRequested = false;

  nextGeneration();

  await teardownSocket();

  if (removeSession) {
    removeAuth();
  }

  state.phone = '';
  state.name = '';
  state.connected_at = 0;

  setStatus(
    'disconnected',
    {
      phone: '',
      name: '',
      connected_at: 0,
      last_error: '',
      mode: '',
      pairing_code: '',
      pairing_phone: '',
    }
  );
}

/* ============================================================
 * RESET
 * ============================================================
 */

async function resetConnector() {
  await disconnectSocket(true);

  state.reconnect_count = 0;

  state.qr = '';
  state.qr_expires_at = 0;

  state.pairing_code = '';
  state.pairing_phone = '';

  state.last_error = '';

  setStatus(
    'disconnected'
  );
}

/* ============================================================
 * MESSAGE TEXT EXTRACTION
 * ============================================================
 */

function extractMessageText(
  message
) {
  const m =
    message?.message || {};

  return (
    m.conversation ||

    m.extendedTextMessage?.text ||

    m.imageMessage?.caption ||

    m.videoMessage?.caption ||

    m.documentMessage?.caption ||

    m.buttonsResponseMessage?.selectedDisplayText ||

    m.listResponseMessage?.title ||

    m.templateButtonReplyMessage?.selectedDisplayText ||

    m.interactiveResponseMessage?.body?.text ||

    ''
  );
}

/* ============================================================
 * SEND MESSAGE
 * ============================================================
 */

async function sendOne(
  payload = {}
) {
  if (
    !sock ||
    state.status !==
      'connected'
  ) {
    const error =
      new Error(
        'WhatsApp is not connected'
      );

    error.code =
      'WHATSAPP_NOT_CONNECTED';

    throw error;
  }

  const phone =
    cleanPhone(
      payload.phone
    );

  if (
    !phone ||
    phone.length < 8 ||
    phone.length > 15
  ) {
    const error =
      new Error(
        'Invalid phone number'
      );

    error.code =
      'INVALID_PHONE';

    throw error;
  }

  const jid =
    jidFromPhone(phone);

  const type =
    safeString(
      payload.type || 'text'
    ).toLowerCase();

  let content;

  switch (type) {

    /*
     * TEXT
     */

    case 'text': {
      const text =
        safeString(
          payload.message
        );

      if (!text.trim()) {
        const error =
          new Error(
            'Message text is empty'
          );

        error.code =
          'INVALID_MESSAGE';

        throw error;
      }

      content = {
        text,
      };

      break;
    }

    /*
     * IMAGE
     */

    case 'image': {
      if (!payload.url) {
        const error =
          new Error(
            'Image URL is required'
          );

        error.code =
          'INVALID_MESSAGE';

        throw error;
      }

      content = {
        image: {
          url: payload.url,
        },

        caption:
          payload.caption ||
          undefined,
      };

      break;
    }

    /*
     * VIDEO
     */

    case 'video': {
      if (!payload.url) {
        const error =
          new Error(
            'Video URL is required'
          );

        error.code =
          'INVALID_MESSAGE';

        throw error;
      }

      content = {
        video: {
          url: payload.url,
        },

        caption:
          payload.caption ||
          undefined,
      };

      break;
    }

    /*
     * AUDIO
     */

    case 'audio': {
      if (!payload.url) {
        const error =
          new Error(
            'Audio URL is required'
          );

        error.code =
          'INVALID_MESSAGE';

        throw error;
      }

      content = {
        audio: {
          url: payload.url,
        },

        mimetype:
          payload.mimetype ||
          'audio/mp4',

        ptt:
          Boolean(payload.ptt),
      };

      break;
    }

    /*
     * DOCUMENT
     */

    case 'document': {
      if (!payload.url) {
        const error =
          new Error(
            'Document URL is required'
          );

        error.code =
          'INVALID_MESSAGE';

        throw error;
      }

      content = {
        document: {
          url: payload.url,
        },

        fileName:
          payload.filename ||
          'document',

        mimetype:
          payload.mimetype ||
          'application/octet-stream',

        caption:
          payload.caption ||
          undefined,
      };

      break;
    }

    /*
     * LOCATION
     */

    case 'location': {
      const latitude =
        Number(
          payload.latitude
        );

      const longitude =
        Number(
          payload.longitude
        );

      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        const error =
          new Error(
            'Valid latitude and longitude are required'
          );

        error.code =
          'INVALID_MESSAGE';

        throw error;
      }

      content = {
        location: {
          degreesLatitude:
            latitude,

          degreesLongitude:
            longitude,

          name:
            payload.name ||
            undefined,

          address:
            payload.address ||
            undefined,
        },
      };

      break;
    }

    /*
     * CONTACT
     */

    case 'contact': {
      const contactName =
        safeString(
          payload.name
        ).trim();

      const contactPhone =
        cleanPhone(
          payload.contact_phone
        );

      if (
        !contactName ||
        !contactPhone
      ) {
        const error =
          new Error(
            'Contact name and contact phone are required'
          );

        error.code =
          'INVALID_MESSAGE';

        throw error;
      }

      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${contactName}`,
        `TEL;type=CELL;type=VOICE;waid=${contactPhone}:+${contactPhone}`,
        'END:VCARD',
      ].join('\n');

      content = {
        contacts: {
          displayName:
            contactName,

          contacts: [
            {
              vcard,
            },
          ],
        },
      };

      break;
    }

    default: {
      const error =
        new Error(
          `Unsupported message type: ${type}`
        );

      error.code =
        'INVALID_MESSAGE';

      throw error;
    }
  }

  const result =
    await sock.sendMessage(
      jid,
      content
    );

  const messageId =
    result?.key?.id || '';

  await forwardToPanel(
    'message.sent',
    {
      phone,
      type,
      message_id:
        messageId,
    }
  );

  return messageId;
}

/* ============================================================
 * EXPRESS APP
 * ============================================================
 */

const app =
  express();

app.disable('x-powered-by');

app.use(
  express.json({
    limit: '5mb',
  })
);

/* ============================================================
 * REQUEST LOG
 * ============================================================
 */

app.use(
  (req, _res, next) => {
    logger.debug(
      {
        method:
          req.method,

        path:
          req.path,

        ip:
          req.ip,
      },
      'HTTP request'
    );

    next();
  }
);

/* ============================================================
 * AUTH MIDDLEWARE
 * ============================================================
 */

app.use(
  (req, res, next) => {
    if (!API_TOKEN) {
      return next();
    }

    const authorization =
      safeString(
        req.headers.authorization
      );

    const token =
      authorization.startsWith(
        'Bearer '
      )
        ? authorization.slice(7)
        : safeString(
            req.headers[
              'x-connector-token'
            ]
          );

    if (
      token !== API_TOKEN
    ) {
      return res
        .status(401)
        .json({
          success: false,

          error: {
            code:
              'UNAUTHORIZED',

            message:
              'Invalid API token',
          },
        });
    }

    next();
  }
);

/* ============================================================
 * RESPONSE HELPERS
 * ============================================================
 */

function ok(
  res,
  data = {}
) {
  return res.json({
    success: true,
    ...data,
  });
}

function fail(
  res,
  message,
  code = 'ERROR',
  http = 400
) {
  return res
    .status(http)
    .json({
      success: false,

      error: {
        code,
        message,
      },
    });
}

/* ============================================================
 * ROOT
 * ============================================================
 */

app.get(
  '/',
  (_req, res) => {
    return ok(
      res,
      {
        service:
          'wa-connector',

        version:
          '3.0.0',

        status:
          state.status,

        uptime:
          process.uptime(),

        node:
          process.version,
      }
    );
  }
);

/* ============================================================
 * HEALTH
 * ============================================================
 */

app.get(
  '/health',
  (_req, res) => {
    return ok(
      res,
      {
        status:
          state.status,

        whatsapp:
          Boolean(
            sock &&
            state.status ===
              'connected'
          ),

        uptime:
          process.uptime(),

        timestamp:
          nowSec(),
      }
    );
  }
);

/* ============================================================
 * STATUS
 * ============================================================
 */

app.get(
  '/status',
  (_req, res) => {
    return ok(
      res,
      {
        status:
          state.status,

        phone:
          state.phone,

        name:
          state.name,

        connected_at:
          state.connected_at,

        qr_available:
          Boolean(state.qr),

        qr_expires_at:
          state.qr_expires_at,

        pairing_code:
          state.pairing_code,

        pairing_phone:
          state.pairing_phone,

        last_error:
          state.last_error,

        mode:
          state.mode,

        reconnect_count:
          state.reconnect_count,

        last_change:
          state.last_change,

        last_qr_at:
          state.last_qr_at,
      }
    );
  }
);

/* ============================================================
 * QR ENDPOINT
 * ============================================================
 */

app.get(
  '/qr',
  async (_req, res) => {
    /*
     * Already connected.
     */

    if (
      state.status ===
      'connected'
    ) {
      return ok(
        res,
        {
          status:
            'connected',

          qr: '',
        }
      );
    }

    /*
     * Existing QR.
     */

    if (
      state.qr &&
      state.qr_expires_at >
        nowSec()
    ) {
      return ok(
        res,
        {
          status:
            'qr',

          qr:
            state.qr,

          expires_at:
            state.qr_expires_at,
        }
      );
    }

    /*
     * If another socket is currently starting,
     * don't start another one.
     */

    if (
      !sock &&
      !starting
    ) {
      startSocket('qr')
        .catch(error => {
          logger.warn(
            {
              error:
                getErrorMessage(
                  error
                ),
            },
            'QR endpoint start failed'
          );
        });
    }

    return ok(
      res,
      {
        status:
          state.status ===
          'disconnected'
            ? 'connecting'
            : state.status,

        qr: '',
      }
    );
  }
);

/* ============================================================
 * CONNECT
 * ============================================================
 */

app.post(
  '/connect',
  async (_req, res) => {
    if (
      state.status ===
      'connected'
    ) {
      return ok(
        res,
        {
          status:
            'connected',

          phone:
            state.phone,
        }
      );
    }

    if (
      starting
    ) {
      return ok(
        res,
        {
          status:
            state.status ||
            'connecting',
        }
      );
    }

    try {
      await startSocket(
        'qr'
      );

      return ok(
        res,
        {
          status:
            state.status,
        }
      );

    } catch (error) {
      return fail(
        res,
        getErrorMessage(
          error
        ),
        'CONNECT_FAILED',
        500
      );
    }
  }
);

/* ============================================================
 * PAIR
 * ============================================================
 */

app.post(
  '/pair',
  async (
    req,
    res
  ) => {
    const phone =
      cleanPhone(
        req.body?.phone
      );

    if (
      phone.length < 8 ||
      phone.length > 15
    ) {
      return fail(
        res,
        'Enter phone number with country code. Example: 919876543210',
        'INVALID_PHONE',
        422
      );
    }

    if (
      state.status ===
      'connected'
    ) {
      return fail(
        res,
        'WhatsApp is already connected',
        'ALREADY_CONNECTED',
        409
      );
    }

    if (
      starting &&
      state.mode ===
        'pair'
    ) {
      return ok(
        res,
        {
          status:
            state.status,

          code:
            state.pairing_code ||
            '',
        }
      );
    }

    try {
      await startSocket(
        'pair',
        phone
      );

      /*
       * Normally pairing code should now exist.
       */

      if (
        state.pairing_code
      ) {
        return ok(
          res,
          {
            status:
              'pairing',

            code:
              state.pairing_code,

            phone:
              phone,
          }
        );
      }

      return fail(
        res,
        state.last_error ||
          'Pairing code was not generated',
        'PAIR_FAILED',
        500
      );

    } catch (error) {
      return fail(
        res,
        getErrorMessage(
          error
        ),
        'PAIR_FAILED',
        500
      );
    }
  }
);

/* ============================================================
 * DISCONNECT
 * ============================================================
 */

app.post(
  '/disconnect',
  async (_req, res) => {
    try {
      /*
       * Keep session by default.
       * This disconnects the active socket but
       * does NOT destroy authentication.
       */

      await disconnectSocket(
        false
      );

      return ok(
        res,
        {
          status:
            'disconnected',
        }
      );

    } catch (error) {
      return fail(
        res,
        getErrorMessage(
          error
        ),
        'DISCONNECT_FAILED',
        500
      );
    }
  }
);

/* ============================================================
 * RESET
 * ============================================================
 */

app.post(
  '/reset',
  async (_req, res) => {
    try {
      await resetConnector();

      return ok(
        res,
        {
          status:
            'disconnected',
        }
      );

    } catch (error) {
      return fail(
        res,
        getErrorMessage(
          error
        ),
        'RESET_FAILED',
        500
      );
    }
  }
);

/* ============================================================
 * SEND MESSAGE
 * ============================================================
 */

async function handleSend(
  req,
  res
) {
  try {
    const id =
      await sendOne(
        req.body || {}
      );

    return ok(
      res,
      {
        message_id:
          id,

        status:
          'sent',
      }
    );

  } catch (error) {
    const code =
      error.code ||
      'SEND_FAILED';

    let http = 500;

    if (
      code ===
      'WHATSAPP_NOT_CONNECTED'
    ) {
      http = 409;
    }

    if (
      code ===
        'INVALID_PHONE' ||
      code ===
        'INVALID_MESSAGE'
    ) {
      http = 422;
    }

    return fail(
      res,
      getErrorMessage(
        error
      ),
      code,
      http
    );
  }
}

app.post(
  '/send-message',
  handleSend
);

app.post(
  '/send-media',
  handleSend
);

/* ============================================================
 * TEST SEND
 * ============================================================
 */

app.post(
  '/send-text',
  async (
    req,
    res
  ) => {
    try {
      const id =
        await sendOne({
          phone:
            req.body?.phone,

          type:
            'text',

          message:
            req.body?.message,
        });

      return ok(
        res,
        {
          message_id:
            id,

          status:
            'sent',
        }
      );

    } catch (error) {
      const code =
        error.code ||
        'SEND_FAILED';

      const http =
        code ===
        'WHATSAPP_NOT_CONNECTED'
          ? 409
          : 422;

      return fail(
        res,
        getErrorMessage(
          error
        ),
        code,
        http
      );
    }
  }
);

/* ============================================================
 * 404
 * ============================================================
 */

app.use(
  (_req, res) => {
    return res
      .status(404)
      .json({
        success: false,

        error: {
          code:
            'NOT_FOUND',

          message:
            'Endpoint not found',
        },
      });
  }
);

/* ============================================================
 * EXPRESS ERROR HANDLER
 * ============================================================
 */

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    logger.error(
      {
        error:
          getErrorMessage(
            error
          ),
      },
      'Express error'
    );

    return res
      .status(500)
      .json({
        success: false,

        error: {
          code:
            'INTERNAL_ERROR',

          message:
            getErrorMessage(
              error
            ),
        },
      });
  }
);

/* ============================================================
 * WATCHDOG
 * ============================================================
 */

function startWatchdog() {
  if (watchdogTimer) {
    clearInterval(
      watchdogTimer
    );
  }

  watchdogTimer =
    setInterval(
      async () => {
        try {
          /*
           * Connecting for too long.
           */

          if (
            state.status ===
              'connecting' &&
            nowMs() -
              state.last_change >
              CONNECTING_TIMEOUT
          ) {
            logger.warn(
              'connection appears stuck — restarting socket'
            );

            if (
              !starting &&
              !stopRequested
            ) {
              try {
                await startSocket(
                  state.mode ||
                    'qr'
                );
              } catch (
                error
              ) {
                logger.warn(
                  {
                    error:
                      getErrorMessage(
                        error
                      ),
                  },
                  'watchdog restart failed'
                );
              }
            }
          }

          /*
           * QR expired.
           */

          if (
            state.status ===
              'qr' &&
            state.qr_expires_at &&
            nowSec() >
              state.qr_expires_at
          ) {
            logger.info(
              'QR expired — restarting QR socket'
            );

            if (
              !starting &&
              !stopRequested
            ) {
              try {
                await startSocket(
                  'qr'
                );
              } catch (
                error
              ) {
                logger.warn(
                  {
                    error:
                      getErrorMessage(
                        error
                      ),
                  },
                  'QR regeneration failed'
                );
              }
            }
          }

        } catch (error) {
          logger.warn(
            {
              error:
                getErrorMessage(
                  error
                ),
            },
            'watchdog error'
          );
        }

      },
      WATCHDOG_INTERVAL
    );
}

/* ============================================================
 * STARTUP
 * ============================================================
 */

async function bootstrap() {
  logger.info(
    'starting WhatsApp connector'
  );

  logger.info(
    {
      node:
        process.version,

      port:
        PORT,

      host:
        HOST,

      auth:
        AUTH_DIR,

      api_auth:
        Boolean(API_TOKEN),
    },
    'configuration'
  );

  startWatchdog();

  /*
   * Resume previous session.
   *
   * If credentials exist, WhatsApp should reconnect
   * without asking for QR again.
   */

  if (authExists()) {
    logger.info(
      'existing WhatsApp session found — attempting resume'
    );

    startSocket(
      'qr'
    ).catch(error => {
      logger.warn(
        {
          error:
            getErrorMessage(
              error
            ),
        },
        'session resume failed'
      );
    });

  } else {
    logger.info(
      'no existing WhatsApp session found'
    );
  }

  /*
   * Start HTTP server.
   */

  app.listen(
    PORT,
    HOST,
    () => {
      logger.info(
        `WA Connector listening on http://${HOST}:${PORT}`
      );
    }
  );
}

/* ============================================================
 * GRACEFUL SHUTDOWN
 * ============================================================
 */

let shuttingDown = false;

async function shutdown(
  signal
) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  logger.info(
    {
      signal,
    },
    'shutdown requested'
  );

  stopRequested = true;

  clearTimeout(
    reconnectTimer
  );

  reconnectTimer = null;

  if (watchdogTimer) {
    clearInterval(
      watchdogTimer
    );

    watchdogTimer = null;
  }

  try {
    await teardownSocket();
  } catch (_) {}

  logger.info(
    'connector stopped'
  );

  process.exit(0);
}

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);

process.on(
  'uncaughtException',
  error => {
    logger.error(
      {
        error:
          getErrorMessage(
            error
          ),

        stack:
          error?.stack,
      },
      'uncaught exception'
    );
  }
);

process.on(
  'unhandledRejection',
  reason => {
    logger.error(
      {
        error:
          getErrorMessage(
            reason
          ),
      },
      'unhandled rejection'
    );
  }
);

/* ============================================================
 * RUN
 * ============================================================
 */

bootstrap().catch(
  error => {
    logger.fatal(
      {
        error:
          getErrorMessage(
            error
          ),

        stack:
          error?.stack,
      },
      'bootstrap failed'
    );

    process.exit(1);
  }
);
