/**
 * ============================================================
 * WhatsApp Multi-Account Connector
 * ============================================================
 *
 * NO API KEY
 * NO AUTHENTICATION
 *
 * Same endpoints:
 *
 * GET  /
 * GET  /health
 * GET  /status
 * GET  /qr
 *
 * POST /connect
 * POST /pair
 * POST /disconnect
 * POST /reset
 * POST /send-message
 * POST /send-media
 *
 * NEW:
 * POST /send-to-all
 *
 * FEATURES:
 * - Multi account
 * - Persistent Baileys sessions
 * - QR login
 * - Pairing code
 * - Automatic reconnect
 * - Message sending
 * - Media sending
 * - Broadcast to supplied recipients
 * - First-message auto reply
 * - Persistent replied-user tracking
 * - Automatic unavailable presence after inactivity
 * - Graceful shutdown
 *
 * ============================================================
 */

'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const P = require('pino');
const QRCode = require('qrcode');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');


/* ============================================================
   APP
   ============================================================ */

const app = express();

const PORT =
  Number(process.env.PORT || 3000);

const HOST =
  String(process.env.HOST || '0.0.0.0');

const DEFAULT_COUNTRY =
  String(
    process.env.DEFAULT_COUNTRY || '91'
  )
    .replace(/\D/g, '') || '91';

const AUTH_DIR =
  path.resolve(
    process.env.AUTH_DIR || './auth_info'
  );

const QR_TTL_MS =
  Number(
    process.env.QR_TTL_MS ||
    5 * 60 * 1000
  );

const LOG_LEVEL =
  process.env.LOG_LEVEL || 'info';

const RECONNECT_DELAY_MS =
  Number(
    process.env.RECONNECT_DELAY_MS ||
    5000
  );

const MAX_RECONNECT_DELAY_MS =
  Number(
    process.env.MAX_RECONNECT_DELAY_MS ||
    60000
  );

const JSON_LIMIT =
  process.env.JSON_LIMIT ||
  '5mb';


/*
 * How long an account can stay inactive
 * before presence becomes unavailable.
 *
 * Default: 5 minutes.
 */
const IDLE_TIMEOUT_MS =
  Number(
    process.env.IDLE_TIMEOUT_MS ||
    5 * 60 * 1000
  );


/*
 * Auto reply.
 */
const AUTO_REPLY_ENABLED =
  String(
    process.env.AUTO_REPLY_ENABLED ?? 'true'
  ).toLowerCase() !== 'false';

const AUTO_REPLY_TEXT =
  String(
    process.env.AUTO_REPLY_TEXT ||
    "Thanks for your message! 💬\n\nRipun is currently offline. He’ll reply as soon as possible. 😊"
  );


/* ============================================================
   LOGGER
   ============================================================ */

const logger =
  P({
    level: LOG_LEVEL,
    base: undefined,
    timestamp:
      P.stdTimeFunctions.isoTime
  });


/* ============================================================
   EXPRESS
   ============================================================ */

app.disable('x-powered-by');

app.use(
  cors({
    origin: true,
    methods: [
      'GET',
      'POST',
      'OPTIONS'
    ],
    allowedHeaders: [
      'Content-Type',
      'X-Account-ID',
      'X-Connection-ID'
    ]
  })
);

app.use(
  express.json({
    limit: JSON_LIMIT
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: JSON_LIMIT
  })
);


/* ============================================================
   DIRECTORIES
   ============================================================ */

fs.mkdirSync(
  AUTH_DIR,
  {
    recursive: true
  }
);


/*
 * Separate data directory.
 *
 * This stores:
 *
 * data/
 *   user1/
 *      replied.json
 *
 * This allows first-message tracking
 * to survive restarts.
 */
const DATA_DIR =
  path.resolve(
    process.env.DATA_DIR || './data'
  );

fs.mkdirSync(
  DATA_DIR,
  {
    recursive: true
  }
);


/* ============================================================
   ACCOUNT STORAGE
   ============================================================ */

const accounts =
  new Map();


/* ============================================================
   HELPERS
   ============================================================ */

function cleanAccountId(value) {

  const id =
    String(value || '').trim();

  if (!id) {
    return 'user1';
  }

  const safe =
    id
      .replace(
        /[^a-zA-Z0-9_-]/g,
        ''
      )
      .slice(0, 64);

  return safe || 'user1';
}


function accountIdFromRequest(req) {

  return cleanAccountId(
    req.body?.account ||
    req.body?.account_id ||
    req.query?.account ||
    req.query?.account_id ||
    req.headers['x-account-id'] ||
    req.headers['x-connection-id'] ||
    'user1'
  );

}


function authPath(account) {

  return path.join(
    AUTH_DIR,
    account
  );

}


function dataPath(account) {

  const dir =
    path.join(
      DATA_DIR,
      account
    );

  fs.mkdirSync(
    dir,
    {
      recursive: true
    }
  );

  return dir;
}


function repliedPath(account) {

  return path.join(
    dataPath(account),
    'replied.json'
  );

}


function createAccountState(account) {

  if (!accounts.has(account)) {

    accounts.set(
      account,
      {

        id: account,

        sock: null,

        connecting: false,

        connected: false,

        status: 'disconnected',

        phone: null,

        jid: null,

        qr: null,

        qrImage: null,

        qrCreatedAt: null,

        qrExpiresAt: null,

        pairingCode: null,

        pairingCreatedAt: null,

        connectedAt: null,

        lastDisconnect: null,

        lastError: null,

        reconnectTimer: null,

        reconnectDelay:
          RECONNECT_DELAY_MS,

        generation: 0,

        lastActivity:
          null,

        isAvailable:
          false,

        idleTimer:
          null,

        repliedUsers:
          loadRepliedUsers(account),

        incomingMessages:
          0,

        outgoingMessages:
          0,

        autoReplies:
          0

      }
    );

  }

  return accounts.get(account);
}


/* ============================================================
   REPLIED USER STORAGE
   ============================================================ */

function loadRepliedUsers(account) {

  const file =
    repliedPath(account);

  try {

    if (
      !fs.existsSync(file)
    ) {

      return {};

    }

    const raw =
      fs.readFileSync(
        file,
        'utf8'
      );

    const parsed =
      JSON.parse(raw);

    if (
      parsed &&
      typeof parsed === 'object'
    ) {

      return parsed;

    }

  } catch (err) {

    logger.warn(
      {
        account,
        err: String(err)
      },
      'Could not load replied users'
    );

  }

  return {};
}


function saveRepliedUsers(state) {

  try {

    fs.writeFileSync(
      repliedPath(state.id),
      JSON.stringify(
        state.repliedUsers,
        null,
        2
      ),
      'utf8'
    );

  } catch (err) {

    logger.error(
      {
        account: state.id,
        err: String(err)
      },
      'Could not save replied users'
    );

  }

}


function hasReceivedAutoReply(
  state,
  phone
) {

  return Boolean(
    state.repliedUsers[phone]
  );

}


function markAutoReplySent(
  state,
  phone
) {

  state.repliedUsers[phone] = {
    replied_at:
      new Date().toISOString()
  };

  saveRepliedUsers(state);

}


/* ============================================================
   QR
   ============================================================ */

function clearQR(state) {

  state.qr = null;

  state.qrImage = null;

  state.qrCreatedAt = null;

  state.qrExpiresAt = null;

}


function clearPairing(state) {

  state.pairingCode = null;

  state.pairingCreatedAt = null;

}


function qrIsValid(state) {

  return Boolean(
    state.qr &&
    state.qrImage &&
    state.qrExpiresAt &&
    Date.now() <
      state.qrExpiresAt
  );

}


/* ============================================================
   PHONE
   ============================================================ */

function normalizePhone(input) {

  let value =
    String(input || '').trim();

  if (!value) {

    throw new Error(
      'Phone number is required'
    );

  }

  value =
    value.replace(
      /[^\d+]/g,
      ''
    );

  if (
    value.startsWith('+')
  ) {

    value =
      value.slice(1);

  }

  if (
    value.startsWith('00')
  ) {

    value =
      value.slice(2);

  }

  let digits =
    value.replace(
      /\D/g,
      ''
    );

  if (!digits) {

    throw new Error(
      'Invalid phone number'
    );

  }

  if (
    digits.length <= 10
  ) {

    digits =
      DEFAULT_COUNTRY +
      digits.replace(
        /^0+/,
        ''
      );

  }

  return digits;

}


function jidForPhone(phone) {

  return (
    normalizePhone(phone) +
    '@s.whatsapp.net'
  );

}


function extractPhoneFromJid(jid) {

  if (!jid) {
    return null;
  }

  return (
    String(jid)
      .split(':')[0]
      .split('@')[0] ||
    null
  );

}


/* ============================================================
   PRESENCE / ONLINE STATUS
   ============================================================ */

function clearIdleTimer(state) {

  if (
    state.idleTimer
  ) {

    clearTimeout(
      state.idleTimer
    );

    state.idleTimer =
      null;

  }

}


async function setUnavailable(state) {

  if (
    !state.sock ||
    !state.connected
  ) {

    return;

  }

  try {

    await state.sock
      .sendPresenceUpdate(
        'unavailable'
      );

    state.isAvailable =
      false;

    logger.debug(
      {
        account: state.id
      },
      'Account marked unavailable'
    );

  } catch (err) {

    logger.debug(
      {
        account: state.id,
        err: String(err)
      },
      'Could not update unavailable presence'
    );

  }

}


function scheduleIdlePresence(state) {

  clearIdleTimer(state);

  state.idleTimer =
    setTimeout(
      async () => {

        state.idleTimer =
          null;

        await setUnavailable(
          state
        );

      },
      IDLE_TIMEOUT_MS
    );

}


async function markActive(state) {

  state.lastActivity =
    Date.now();

  if (
    state.sock &&
    state.connected
  ) {

    try {

      await state.sock
        .sendPresenceUpdate(
          'available'
        );

      state.isAvailable =
        true;

    } catch (_) {}

  }

  scheduleIdlePresence(
    state
  );

}


/* ============================================================
   STATUS
   ============================================================ */

function getStatus(state) {

  return {

    success: true,

    account:
      state.id,

    status:
      state.status,

    connected:
      state.connected,

    available:
      state.isAvailable,

    phone:
      state.phone,

    jid:
      state.jid,

    qr_available:
      qrIsValid(state),

    qr_created_at:
      state.qrCreatedAt
        ? new Date(
            state.qrCreatedAt
          ).toISOString()
        : null,

    expires_at:
      state.qrExpiresAt
        ? new Date(
            state.qrExpiresAt
          ).toISOString()
        : null,

    pairing_code:
      state.pairingCode,

    pairing_created_at:
      state.pairingCreatedAt
        ? new Date(
            state.pairingCreatedAt
          ).toISOString()
        : null,

    connected_at:
      state.connectedAt
        ? new Date(
            state.connectedAt
          ).toISOString()
        : null,

    last_activity:
      state.lastActivity
        ? new Date(
            state.lastActivity
          ).toISOString()
        : null,

    incoming_messages:
      state.incomingMessages,

    outgoing_messages:
      state.outgoingMessages,

    auto_replies:
      state.autoReplies,

    remembered_recipients:
      Object.keys(
        state.repliedUsers
      ).length,

    last_disconnect:
      state.lastDisconnect,

    error:
      state.lastError

  };

}


/* ============================================================
   AUTO REPLY
   ============================================================ */

async function processIncomingMessage(
  state,
  message
) {

  try {

    if (
      !AUTO_REPLY_ENABLED
    ) {

      return;

    }

    if (
      !message ||
      message.key?.fromMe
    ) {

      return;

    }

    const remoteJid =
      message.key?.remoteJid;

    if (!remoteJid) {
      return;
    }


    /*
     * Ignore groups.
     */
    if (
      remoteJid.endsWith(
        '@g.us'
      )
    ) {

      return;

    }


    /*
     * Ignore broadcast/system chats.
     */
    if (
      remoteJid ===
      'status@broadcast'
    ) {

      return;

    }


    const phone =
      extractPhoneFromJid(
        remoteJid
      );

    if (!phone) {
      return;
    }


    state.incomingMessages += 1;

    await markActive(
      state
    );


    /*
     * Only first incoming message
     * from this person.
     */
    if (
      hasReceivedAutoReply(
        state,
        phone
      )
    ) {

      return;

    }


    /*
     * Mark BEFORE sending.
     *
     * This prevents duplicate auto replies
     * if WhatsApp emits the event twice.
     */
    markAutoReplySent(
      state,
      phone
    );


    try {

      await state.sock.sendMessage(
        remoteJid,
        {
          text:
            AUTO_REPLY_TEXT
        }
      );

      state.autoReplies += 1;

      state.outgoingMessages += 1;

      logger.info(
        {
          account: state.id,
          phone
        },
        'First-message auto reply sent'
      );

    } catch (err) {

      /*
       * If sending failed, remove the marker
       * so the next message can retry.
       */
      delete state.repliedUsers[
        phone
      ];

      saveRepliedUsers(
        state
      );

      logger.error(
        {
          account: state.id,
          phone,
          err: String(err)
        },
        'Auto reply failed'
      );

    }

  } catch (err) {

    logger.error(
      {
        account: state.id,
        err: String(err)
      },
      'Incoming message processing failed'
    );

  }

}


/* ============================================================
   CREATE SOCKET
   ============================================================ */

async function createSocket(account) {

  const state =
    createAccountState(
      account
    );


  if (state.sock) {

    return state.sock;

  }


  if (state.connecting) {

    /*
     * Wait for another socket creation.
     */
    await waitForCondition(
      () =>
        state.sock ||
        !state.connecting,
      15000
    ).catch(() => {});

    if (state.sock) {

      return state.sock;

    }

  }


  state.connecting =
    true;

  state.status =
    'connecting';

  state.lastError =
    null;

  state.generation += 1;

  const myGeneration =
    state.generation;


  const accountAuthDir =
    authPath(account);

  fs.mkdirSync(
    accountAuthDir,
    {
      recursive: true
    }
  );


  try {

    const authState =
      await useMultiFileAuthState(
        accountAuthDir
      );


    let version;


    try {

      const latest =
        await fetchLatestBaileysVersion();

      version =
        latest.version;

      logger.info(
        {
          account,
          version
        },
        'Using latest Baileys version'
      );

    } catch (err) {

      logger.warn(
        {
          account,
          err: String(err)
        },
        'Could not fetch latest Baileys version'
      );

    }


    const socketOptions = {

      auth: {

        creds:
          authState.state.creds,

        keys:
          makeCacheableSignalKeyStore(
            authState.state.keys,
            logger
          )

      },

      browser:
        Browsers.ubuntu(
          'Chrome'
        ),

      printQRInTerminal:
        false,

      markOnlineOnConnect:
        false,

      syncFullHistory:
        false,

      generateHighQualityLinkPreview:
        false,

      logger

    };


    if (version) {

      socketOptions.version =
        version;

    }


    const sock =
      makeWASocket(
        socketOptions
      );


    state.sock =
      sock;

    state.connecting =
      false;


    sock.ev.on(
      'creds.update',
      authState.saveCreds
    );


    /* ========================================================
       INCOMING MESSAGES
       ======================================================== */

    sock.ev.on(
      'messages.upsert',
      async ({
        messages,
        type
      }) => {

        /*
         * Handle notify messages.
         */
        if (
          type !== 'notify'
        ) {

          return;

        }

        for (
          const message of
          messages || []
        ) {

          await processIncomingMessage(
            state,
            message
          );

        }

      }
    );


    /* ========================================================
       CONNECTION EVENTS
       ======================================================== */

    sock.ev.on(
      'connection.update',
      async update => {

        if (
          state.generation !==
          myGeneration
        ) {

          return;

        }


        const {
          connection,
          lastDisconnect,
          qr
        } = update;


        /* ----------------------------------------------------
           QR
        ---------------------------------------------------- */

        if (qr) {

          try {

            state.qr =
              qr;

            state.qrCreatedAt =
              Date.now();

            state.qrExpiresAt =
              Date.now() +
              QR_TTL_MS;


            state.qrImage =
              await QRCode.toDataURL(
                qr,
                {
                  errorCorrectionLevel:
                    'M',
                  margin: 2,
                  width: 420
                }
              );


            logger.info(
              {
                account,
                expiresAt:
                  new Date(
                    state.qrExpiresAt
                  ).toISOString()
              },
              'New QR generated'
            );

          } catch (err) {

            state.lastError =
              String(
                err?.message ||
                err
              );

          }

        }


        /* ----------------------------------------------------
           OPEN
        ---------------------------------------------------- */

        if (
          connection === 'open'
        ) {

          state.connected =
            true;

          state.status =
            'connected';

          state.connecting =
            false;

          state.connectedAt =
            Date.now();

          state.lastDisconnect =
            null;

          state.lastError =
            null;

          state.reconnectDelay =
            RECONNECT_DELAY_MS;


          clearQR(
            state
          );

          clearPairing(
            state
          );


          state.jid =
            sock.user?.id ||
            null;

          state.phone =
            extractPhoneFromJid(
              state.jid
            );


          await markActive(
            state
          );


          logger.info(
            {
              account,
              jid: state.jid,
              phone: state.phone
            },
            'WhatsApp connected'
          );

        }


        /* ----------------------------------------------------
           CLOSE
        ---------------------------------------------------- */

        if (
          connection === 'close'
        ) {

          state.connected =
            false;

          state.status =
            'disconnected';

          state.connecting =
            false;

          state.isAvailable =
            false;


          clearIdleTimer(
            state
          );


          const errorCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode ??
            lastDisconnect
              ?.error
              ?.statusCode ??
            null;


          state.lastDisconnect = {

            at:
              new Date()
                .toISOString(),

            code:
              errorCode,

            message:
              String(
                lastDisconnect
                  ?.error
                  ?.message ||
                lastDisconnect
                  ?.error ||
                'Connection closed'
              )

          };


          state.sock =
            null;


          const loggedOut =
            errorCode ===
            DisconnectReason.loggedOut;


          const replaced =
            errorCode ===
            DisconnectReason.connectionReplaced;


          logger.warn(
            {
              account,
              errorCode,
              loggedOut,
              replaced
            },
            'WhatsApp connection closed'
          );


          if (
            !loggedOut &&
            !replaced
          ) {

            scheduleReconnect(
              account
            );

          }

        }

      }
    );


    return sock;


  } catch (err) {

    state.sock =
      null;

    state.connecting =
      false;

    state.status =
      'error';

    state.lastError =
      String(
        err?.message ||
        err
      );


    logger.error(
      {
        account,
        err: String(err)
      },
      'Could not create WhatsApp socket'
    );


    throw err;

  }

}


/* ============================================================
   RECONNECT
   ============================================================ */

function scheduleReconnect(
  account
) {

  const state =
    createAccountState(
      account
    );


  if (
    state.reconnectTimer
  ) {

    return;

  }


  const delay =
    Math.min(
      state.reconnectDelay ||
        RECONNECT_DELAY_MS,
      MAX_RECONNECT_DELAY_MS
    );


  state.reconnectTimer =
    setTimeout(
      async () => {

        state.reconnectTimer =
          null;

        try {

          await createSocket(
            account
          );

          state.reconnectDelay =
            RECONNECT_DELAY_MS;

        } catch (err) {

          logger.error(
            {
              account,
              err: String(err)
            },
            'Automatic reconnect failed'
          );


          state.reconnectDelay =
            Math.min(
              Math.max(
                state.reconnectDelay *
                  2,
                RECONNECT_DELAY_MS
              ),
              MAX_RECONNECT_DELAY_MS
            );


          scheduleReconnect(
            account
          );

        }

      },
      delay
    );

}


/* ============================================================
   SOCKET
   ============================================================ */

async function getOrCreateSocket(
  account
) {

  const state =
    createAccountState(
      account
    );


  if (
    state.sock
  ) {

    return state.sock;

  }


  return createSocket(
    account
  );

}


/* ============================================================
   DISCONNECT
   ============================================================ */

async function disconnectSocket(
  account
) {

  const state =
    createAccountState(
      account
    );


  if (
    state.reconnectTimer
  ) {

    clearTimeout(
      state.reconnectTimer
    );

    state.reconnectTimer =
      null;

  }


  clearIdleTimer(
    state
  );


  state.generation += 1;


  const sock =
    state.sock;


  state.sock =
    null;

  state.connecting =
    false;

  state.connected =
    false;

  state.status =
    'disconnected';

  state.isAvailable =
    false;


  clearQR(
    state
  );

  clearPairing(
    state
  );


  if (sock) {

    try {

      sock.end(
        undefined
      );

    } catch (_) {}

  }


  logger.info(
    {
      account
    },
    'Account disconnected'
  );

}


/* ============================================================
   RESET
   ============================================================ */

async function resetAccount(
  account
) {

  const state =
    createAccountState(
      account
    );


  await disconnectSocket(
    account
  );


  const dir =
    authPath(account);


  try {

    await fs.promises.rm(
      dir,
      {
        recursive: true,
        force: true
      }
    );

  } catch (err) {

    logger.warn(
      {
        account,
        err: String(err)
      },
      'Could not remove auth directory'
    );

  }


  state.phone =
    null;

  state.jid =
    null;

  state.connectedAt =
    null;

  state.lastDisconnect =
    null;

  state.lastError =
    null;

  state.repliedUsers =
    {};

  saveRepliedUsers(
    state
  );


  logger.info(
    {
      account
    },
    'Account authentication reset'
  );

}


/* ============================================================
   WAIT
   ============================================================ */

function waitForCondition(
  check,
  timeoutMs = 15000,
  intervalMs = 200
) {

  const started =
    Date.now();


  return new Promise(
    (resolve, reject) => {

      const timer =
        setInterval(
          () => {

            try {

              const result =
                check();


              if (result) {

                clearInterval(
                  timer
                );

                resolve(
                  result
                );

                return;

              }


              if (
                Date.now() -
                started >=
                timeoutMs
              ) {

                clearInterval(
                  timer
                );

                reject(
                  new Error(
                    'Timed out waiting for WhatsApp state'
                  )
                );

              }

            } catch (err) {

              clearInterval(
                timer
              );

              reject(err);

            }

          },
          intervalMs
        );

    }
  );

}


async function waitForQR(
  account,
  timeoutMs = 15000
) {

  const state =
    createAccountState(
      account
    );


  if (
    qrIsValid(state)
  ) {

    return state;

  }


  await getOrCreateSocket(
    account
  );


  return waitForCondition(
    () =>
      qrIsValid(state)
        ? state
        : null,
    timeoutMs
  );

}


/* ============================================================
   RESPONSE HELPERS
   ============================================================ */

function ok(
  res,
  data = {}
) {

  return res
    .status(200)
    .json({

      success: true,

      ...data

    });

}


function fail(
  res,
  status,
  code,
  message,
  extra = {}
) {

  return res
    .status(status)
    .json({

      success: false,

      error: {

        code,

        message,

        ...extra

      }

    });

}


function asyncRoute(fn) {

  return (
    (req, res) => {

      Promise
        .resolve(
          fn(req, res)
        )
        .catch(
          err => {

            logger.error(
              {
                err:
                  String(
                    err?.stack ||
                    err
                  )
              },
              'Unhandled route error'
            );


            if (
              !res.headersSent
            ) {

              fail(
                res,
                500,
                'INTERNAL_ERROR',
                String(
                  err?.message ||
                  err
                )
              );

            }

          }
        );

    }
  );

}


/* ============================================================
   ROOT
   ============================================================ */

app.get(
  '/',
  (req, res) => {

    res.json({

      success: true,

      name:
        'WhatsApp Multi-Account Connector',

      version:
        '2.0.0',

      status:
        'online',

      authentication:
        'none',

      uptime:
        process.uptime(),

      accounts:
        accounts.size,

      features: {

        multi_account:
          true,

        qr:
          true,

        pairing:
          true,

        auto_reconnect:
          true,

        auto_reply:
          AUTO_REPLY_ENABLED,

        first_message_only:
          true,

        broadcast:
          true,

        idle_presence:
          true

      },

      endpoints: {

        health:
          'GET /health',

        status:
          'GET /status?account=user1',

        qr:
          'GET /qr?account=user1',

        connect:
          'POST /connect',

        pair:
          'POST /pair',

        disconnect:
          'POST /disconnect',

        reset:
          'POST /reset',

        sendMessage:
          'POST /send-message',

        sendMedia:
          'POST /send-media',

        sendToAll:
          'POST /send-to-all'

      }

    });

  }
);


/* ============================================================
   HEALTH
   ============================================================ */

app.get(
  '/health',
  (req, res) => {

    res.json({

      success: true,

      status:
        'online',

      authentication:
        'none',

      uptime:
        process.uptime(),

      accounts:
        accounts.size

    });

  }
);


/* ============================================================
   STATUS
   ============================================================ */

app.get(
  '/status',
  (req, res) => {

    const account =
      accountIdFromRequest(
        req
      );


    const state =
      createAccountState(
        account
      );


    res.json(
      getStatus(
        state
      )
    );

  }
);


/* ============================================================
   QR
   ============================================================ */

app.get(
  '/qr',
  asyncRoute(
    async (req, res) => {

      const account =
        accountIdFromRequest(
          req
        );


      const state =
        createAccountState(
          account
        );


      if (
        state.connected
      ) {

        return ok(
          res,
          {

            account,

            connected:
              true,

            qr_available:
              false,

            message:
              'Account is already connected'

          }
        );

      }


      try {

        await waitForQR(
          account,
          15000
        );


        return ok(
          res,
          {

            account,

            qr_available:
              true,

            qr:
              state.qr,

            qr_image:
              state.qrImage,

            created_at:
              new Date(
                state.qrCreatedAt
              ).toISOString(),

            expires_at:
              new Date(
                state.qrExpiresAt
              ).toISOString()

          }
        );


      } catch (err) {

        return fail(
          res,
          409,
          'QR_NOT_AVAILABLE',
          'QR is not available yet. Call POST /connect first and try again.'
        );

      }

    }
  )
);


/* ============================================================
   CONNECT
   ============================================================ */

app.post(
  '/connect',
  asyncRoute(
    async (req, res) => {

      const account =
        accountIdFromRequest(
          req
        );


      const state =
        createAccountState(
          account
        );


      try {

        await getOrCreateSocket(
          account
        );


        if (
          state.connected
        ) {

          return ok(
            res,
            {

              account,

              status:
                'connected',

              connected:
                true,

              phone:
                state.phone,

              jid:
                state.jid

            }
          );

        }


        try {

          await waitForCondition(
            () =>
              state.connected ||
              qrIsValid(state)
                ? true
                : null,
            10000
          );

        } catch (_) {}


        return ok(
          res,
          {

            account,

            status:
              state.status,

            connected:
              state.connected,

            qr_available:
              qrIsValid(state),

            qr_image:
              state.qrImage,

            expires_at:
              state.qrExpiresAt
                ? new Date(
                    state.qrExpiresAt
                  ).toISOString()
                : null,

            phone:
              state.phone,

            jid:
              state.jid,

            message:
              state.connected
                ? 'Connected'
                : 'Connection started. Scan the QR code if provided.'

          }
        );


      } catch (err) {

        return fail(
          res,
          500,
          'CONNECT_FAILED',
          String(
            err?.message ||
            err
          )
        );

      }

    }
  )
);


/* ============================================================
   PAIR
   ============================================================ */

app.post(
  '/pair',
  asyncRoute(
    async (req, res) => {

      const account =
        accountIdFromRequest(
          req
        );


      let phone;


      try {

        phone =
          normalizePhone(
            req.body?.phone ||
            req.body?.number ||
            req.body?.phone_number
          );

      } catch (err) {

        return fail(
          res,
          422,
          'INVALID_PHONE',
          err.message
        );

      }


      const state =
        createAccountState(
          account
        );


      if (
        state.connected
      ) {

        return fail(
          res,
          409,
          'ALREADY_CONNECTED',
          'Account is already connected'
        );

      }


      try {

        const sock =
          await getOrCreateSocket(
            account
          );


        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1500
            )
        );


        const code =
          await sock.requestPairingCode(
            phone
          );


        state.pairingCode =
          code;

        state.pairingCreatedAt =
          Date.now();


        clearQR(
          state
        );


        return ok(
          res,
          {

            account,

            phone,

            pairing_code:
              code,

            created_at:
              new Date(
                state.pairingCreatedAt
              ).toISOString(),

            instructions: [

              'Open WhatsApp on your phone.',

              'Go to Settings > Linked Devices.',

              'Choose Link a Device.',

              'Choose Link with phone number instead.',

              `Enter the pairing code: ${code}`

            ]

          }
        );


      } catch (err) {

        state.lastError =
          String(
            err?.message ||
            err
          );


        return fail(
          res,
          500,
          'PAIRING_FAILED',
          String(
            err?.message ||
            err
          )
        );

      }

    }
  )
);


/* ============================================================
   DISCONNECT
   ============================================================ */

app.post(
  '/disconnect',
  asyncRoute(
    async (req, res) => {

      const account =
        accountIdFromRequest(
          req
        );


      await disconnectSocket(
        account
      );


      return ok(
        res,
        {

          account,

          status:
            'disconnected',

          message:
            'Account disconnected'

        }
      );

    }
  )
);


/* ============================================================
   RESET
   ============================================================ */

app.post(
  '/reset',
  asyncRoute(
    async (req, res) => {

      const account =
        accountIdFromRequest(
          req
        );


      await resetAccount(
        account
      );


      return ok(
        res,
        {

          account,

          status:
            'reset',

          message:
            'Authentication reset. Connect again to create a new QR session.'

        }
      );

    }
  )
);


/* ============================================================
   SEND MESSAGE
   ============================================================ */

app.post(
  '/send-message',
  asyncRoute(
    async (req, res) => {

      const account =
        accountIdFromRequest(
          req
        );


      let phone;


      try {

        phone =
          normalizePhone(
            req.body?.phone ||
            req.body?.number ||
            req.body?.to
          );

      } catch (err) {

        return fail(
          res,
          422,
          'INVALID_PHONE',
          err.message
        );

      }


      const message =
        String(
          req.body?.message ??
          req.body?.text ??
          ''
        ).trim();


      if (!message) {

        return fail(
          res,
          422,
          'MESSAGE_REQUIRED',
          'Message is required'
        );

      }


      const state =
        createAccountState(
          account
        );


      if (
        !state.connected ||
        !state.sock
      ) {

        return fail(
          res,
          409,
          'NOT_CONNECTED',
          `Account ${account} is not connected`
        );

      }


      try {

        await markActive(
          state
        );


        const jid =
          jidForPhone(
            phone
          );


        const result =
          await state.sock.sendMessage(
            jid,
            {
              text: message
            }
          );


        state.outgoingMessages += 1;


        return ok(
          res,
          {

            account,

            phone,

            jid,

            message_id:
              result?.key?.id ||
              null,

            key:
              result?.key ||
              null

          }
        );


      } catch (err) {

        state.lastError =
          String(
            err?.message ||
            err
          );


        return fail(
          res,
          500,
          'SEND_MESSAGE_FAILED',
          String(
            err?.message ||
            err
          )
        );

      }

    }
  )
);


/* ============================================================
   SEND TO ALL
   ============================================================ */

/*
 * POST /send-to-all
 *
 * JSON:
 *
 * {
 *   "account": "user1",
 *   "phones": [
 *     "9876543210",
 *     "9123456789",
 *     "+919876543210"
 *   ],
 *   "message": "Hello!"
 * }
 *
 */

app.post(
  '/send-to-all',
  asyncRoute(
    async (req, res) => {

      const account =
        accountIdFromRequest(
          req
        );


      const state =
        createAccountState(
          account
        );


      if (
        !state.connected ||
        !state.sock
      ) {

        return fail(
          res,
          409,
          'NOT_CONNECTED',
          `Account ${account} is not connected`
        );

      }


      const message =
        String(
          req.body?.message ??
          req.body?.text ??
          ''
        ).trim();


      if (!message) {

        return fail(
          res,
          422,
          'MESSAGE_REQUIRED',
          'Message is required'
        );

      }


      let input =
        req.body?.phones ||
        req.body?.numbers ||
        req.body?.recipients;


      /*
       * Also support:
       *
       * "phone": "..."
       */
      if (
        !input &&
        req.body?.phone
      ) {

        input = [
          req.body.phone
        ];

      }


      if (
        typeof input === 'string'
      ) {

        input =
          input
            .split(',')
            .map(
              x => x.trim()
            )
            .filter(Boolean);

      }


      if (
        !Array.isArray(input) ||
        input.length === 0
      ) {

        return fail(
          res,
          422,
          'RECIPIENTS_REQUIRED',
          'phones must be a non-empty array'
        );

      }


      /*
       * Remove duplicate numbers.
       */
      const unique =
        [
          ...new Set(
            input.map(
              x => {
                try {
                  return normalizePhone(x);
                } catch (_) {
                  return null;
                }
              }
            ).filter(Boolean)
          )
        ];


      if (
        unique.length === 0
      ) {

        return fail(
          res,
          422,
          'NO_VALID_RECIPIENTS',
          'No valid phone numbers were supplied'
        );

      }


      await markActive(
        state
      );


      const results = [];

      for (
        const phone of unique
      ) {

        const jid =
          jidForPhone(
            phone
          );


        try {

          const result =
            await state.sock.sendMessage(
              jid,
              {
                text: message
              }
            );


          state.outgoingMessages += 1;


          results.push({

            phone,

            success:
              true,

            jid,

            message_id:
              result?.key?.id ||
              null

          });


          /*
           * Small delay between messages.
           *
           * This is intentionally conservative
           * to avoid hammering the connection.
           */
          await new Promise(
            resolve =>
              setTimeout(
                resolve,
                250
              )
          );


        } catch (err) {

          results.push({

            phone,

            success:
              false,

            error:
              String(
                err?.message ||
                err
              )

          });

        }

      }


      const sent =
        results.filter(
          x => x.success
        ).length;

      const failed =
        results.length -
        sent;


      return ok(
        res,
        {

          account,

          total:
            results.length,

          sent,

          failed,

          results

        }
      );

    }
  )
);


/* ============================================================
   SEND MEDIA
   ============================================================ */

app.post(
  '/send-media',
  asyncRoute(
    async (req, res) => {

      const account =
        accountIdFromRequest(
          req
        );


      let phone;


      try {

        phone =
          normalizePhone(
            req.body?.phone ||
            req.body?.number ||
            req.body?.to
          );

      } catch (err) {

        return fail(
          res,
          422,
          'INVALID_PHONE',
          err.message
        );

      }


      const mediaUrl =
        String(
          req.body?.media_url ||
          req.body?.url ||
          req.body?.mediaUrl ||
          ''
        ).trim();


      if (!mediaUrl) {

        return fail(
          res,
          422,
          'MEDIA_URL_REQUIRED',
          'media_url is required'
        );

      }


      const type =
        String(
          req.body?.media_type ||
          req.body?.type ||
          'image'
        ).toLowerCase();


      const caption =
        String(
          req.body?.caption ||
          ''
        );


      const state =
        createAccountState(
          account
        );


      if (
        !state.connected ||
        !state.sock
      ) {

        return fail(
          res,
          409,
          'NOT_CONNECTED',
          `Account ${account} is not connected`
        );

      }


      try {

        await markActive(
          state
        );


        const jid =
          jidForPhone(
            phone
          );


        let content;


        if (
          type === 'image' ||
          type === 'photo'
        ) {

          content = {

            image: {
              url: mediaUrl
            },

            caption

          };

        }

        else if (
          type === 'video'
        ) {

          content = {

            video: {
              url: mediaUrl
            },

            caption

          };

        }

        else if (
          type === 'audio'
        ) {

          content = {

            audio: {
              url: mediaUrl
            },

            mimetype:
              req.body?.mimetype ||
              'audio/mpeg',

            ptt:
              String(
                req.body?.ptt ||
                ''
              ).toLowerCase() ===
              'true'

          };

        }

        else if (
          type === 'document' ||
          type === 'file'
        ) {

          content = {

            document: {
              url: mediaUrl
            },

            mimetype:
              req.body?.mimetype ||
              'application/octet-stream',

            fileName:
              req.body?.file_name ||
              req.body?.filename ||
              'file',

            caption

          };

        }

        else {

          return fail(
            res,
            422,
            'INVALID_MEDIA_TYPE',
            'media_type must be image, video, audio, or document'
          );

        }


        const result =
          await state.sock.sendMessage(
            jid,
            content
          );


        state.outgoingMessages += 1;


        return ok(
          res,
          {

            account,

            phone,

            jid,

            media_type:
              type,

            message_id:
              result?.key?.id ||
              null,

            key:
              result?.key ||
              null

          }
        );


      } catch (err) {

        state.lastError =
          String(
            err?.message ||
            err
          );


        return fail(
          res,
          500,
          'SEND_MEDIA_FAILED',
          String(
            err?.message ||
            err
          )
        );

      }

    }
  )
);


/* ============================================================
   404
   ============================================================ */

app.use(
  (req, res) => {

    res.status(404).json({

      success: false,

      error: {

        code:
          'ENDPOINT_NOT_FOUND',

        message:
          'Endpoint not found',

        method:
          req.method,

        path:
          req.path

      }

    });

  }
);


/* ============================================================
   EXPRESS ERROR
   ============================================================ */

app.use(
  (err, req, res, next) => {

    logger.error(
      {
        err:
          String(
            err?.stack ||
            err
          )
      },
      'Express error'
    );


    if (
      res.headersSent
    ) {

      return next(err);

    }


    res.status(500).json({

      success: false,

      error: {

        code:
          'INTERNAL_ERROR',

        message:
          String(
            err?.message ||
            err
          )

      }

    });

  }
);


/* ============================================================
   START
   ============================================================ */

const server =
  app.listen(
    PORT,
    HOST,
    () => {

      logger.info(
        {

          host:
            HOST,

          port:
            PORT,

          authDir:
            AUTH_DIR,

          dataDir:
            DATA_DIR,

          defaultCountry:
            DEFAULT_COUNTRY,

          qrTtlMs:
            QR_TTL_MS,

          idleTimeoutMs:
            IDLE_TIMEOUT_MS,

          autoReply:
            AUTO_REPLY_ENABLED

        },
        'WhatsApp connector started'
      );


      console.log(
        `WhatsApp connector listening on ${HOST}:${PORT}`
      );

    }
  );


/* ============================================================
   RESTORE ACCOUNTS
   ============================================================ */

async function restoreAccounts() {

  try {

    const entries =
      await fs.promises.readdir(
        AUTH_DIR,
        {
          withFileTypes: true
        }
      );


    for (
      const entry of entries
    ) {

      if (
        !entry.isDirectory()
      ) {

        continue;

      }


      const account =
        cleanAccountId(
          entry.name
        );


      if (!account) {

        continue;

      }


      const credsPath =
        path.join(
          AUTH_DIR,
          account,
          'creds.json'
        );


      if (
        fs.existsSync(
          credsPath
        )
      ) {

        logger.info(
          {
            account
          },
          'Restoring saved WhatsApp account'
        );


        createSocket(
          account
        ).catch(
          err => {

            logger.error(
              {
                account,
                err: String(err)
              },
              'Account restore failed'
            );

          }
        );

      }

    }

  } catch (err) {

    logger.error(
      {
        err: String(err)
      },
      'Account restore scan failed'
    );

  }

}


restoreAccounts();


/* ============================================================
   GRACEFUL SHUTDOWN
   ============================================================ */

async function shutdown(
  signal
) {

  logger.info(
    {
      signal
    },
    'Shutting down connector'
  );


  for (
    const [
      account,
      state
    ] of accounts.entries()
  ) {

    try {

      if (
        state.reconnectTimer
      ) {

        clearTimeout(
          state.reconnectTimer
        );

        state.reconnectTimer =
          null;

      }


      clearIdleTimer(
        state
      );


      if (
        state.sock
      ) {

        state.generation += 1;

        state.sock.end(
          undefined
        );

      }


      logger.info(
        {
          account
        },
        'Closed account socket'
      );


    } catch (err) {

      logger.warn(
        {
          account,
          err: String(err)
        },
        'Error while closing account'
      );

    }

  }


  server.close(
    () => {

      process.exit(0);

    }
  );


  setTimeout(
    () => process.exit(0),
    5000
  ).unref();

}


process.on(
  'SIGTERM',
  () =>
    shutdown('SIGTERM')
);

process.on(
  'SIGINT',
  () =>
    shutdown('SIGINT')
);


/* ============================================================
   PROCESS ERRORS
   ============================================================ */

process.on(
  'uncaughtException',
  err => {

    logger.error(
      {
        err:
          String(
            err?.stack ||
            err
          )
      },
      'Uncaught exception'
    );

  }
);


process.on(
  'unhandledRejection',
  err => {

    logger.error(
      {
        err:
          String(
            err?.stack ||
            err
          )
      },
      'Unhandled promise rejection'
    );

  }
);
