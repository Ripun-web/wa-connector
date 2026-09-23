'use strict';

/*
  RB WhatsApp Multi-Account Connector
  ------------------------------------
  Node.js 20+
  Baileys multi-session connector

  Features:
  - Multiple WhatsApp accounts
  - Separate auth folder for every account
  - QR login
  - Pairing-code login
  - Automatic reconnect
  - Connect / disconnect / reset
  - Text messages
  - Image/document/video/audio by URL
  - Bulk queue with rate limiting
  - API token authentication
  - Account status
  - Incoming message events
  - Health endpoint

  IMPORTANT:
  Use bulk messaging only for recipients who have opted in.
*/

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('pino');
const { Boom } = require('@hapi/boom');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const QRCode = require('qrcode');


// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 3000);

const API_TOKEN =
  process.env.API_TOKEN ||
  'CHANGE_THIS_LONG_RANDOM_CONNECTOR_TOKEN';

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, 'data');

const AUTH_DIR =
  process.env.AUTH_DIR ||
  path.join(DATA_DIR, 'auth');

const MAX_BULK_RECIPIENTS =
  Number(process.env.MAX_BULK_RECIPIENTS || 50);

const DEFAULT_DELAY_MS =
  Math.max(
    Number(process.env.DEFAULT_DELAY_MS || 1500),
    1000
  );

const MAX_MESSAGE_LENGTH =
  Number(process.env.MAX_MESSAGE_LENGTH || 4096);


// ============================================================
// DIRECTORIES
// ============================================================

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });


// ============================================================
// LOGGER
// ============================================================

const logger = P({
  level: process.env.LOG_LEVEL || 'info'
});


// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(express.json({
  limit: '2mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '2mb'
}));


// ============================================================
// SECURITY HEADERS
// ============================================================

app.use((req, res, next) => {

  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );

  res.setHeader(
    'X-Frame-Options',
    'DENY'
  );

  res.setHeader(
    'Referrer-Policy',
    'no-referrer'
  );

  next();
});


// ============================================================
// HELPERS
// ============================================================

function now() {
  return new Date().toISOString();
}


function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}


function safeId(value) {

  value = String(value || '').trim();

  if (!value) {
    return null;
  }

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    return null;
  }

  return value;
}


function normalizePhone(phone) {

  let value = String(phone || '')
    .trim()
    .replace(/[^\d]/g, '');

  if (value.startsWith('00')) {
    value = value.substring(2);
  }

  if (!value) {
    return null;
  }

  /*
    Do not automatically guess country codes.

    Example:
    919876543210
  */

  if (value.length < 8 || value.length > 15) {
    return null;
  }

  return value;
}


function jidFromPhone(phone) {

  const normalized = normalizePhone(phone);

  if (!normalized) {
    throw new Error('Invalid phone number');
  }

  return `${normalized}@s.whatsapp.net`;
}


function randomId(prefix = '') {

  return (
    prefix +
    crypto.randomBytes(8).toString('hex')
  );
}


function json(res, status, data) {

  return res
    .status(status)
    .json(data);
}


function ok(res, data = {}) {

  return json(res, 200, {
    success: true,
    ...data
  });
}


function fail(res, status, message, extra = {}) {

  return json(res, status, {
    success: false,
    error: message,
    ...extra
  });
}


// ============================================================
// SIMPLE JSON DATABASE
// ============================================================

const DB_FILE =
  path.join(DATA_DIR, 'accounts.json');


function loadDB() {

  try {

    if (!fs.existsSync(DB_FILE)) {
      return {
        accounts: {}
      };
    }

    const raw =
      fs.readFileSync(
        DB_FILE,
        'utf8'
      );

    const data =
      JSON.parse(raw);

    if (!data.accounts) {
      data.accounts = {};
    }

    return data;

  } catch (error) {

    logger.error(error);

    return {
      accounts: {}
    };
  }
}


let database = loadDB();


function saveDB() {

  const temp =
    DB_FILE + '.tmp';

  fs.writeFileSync(
    temp,
    JSON.stringify(
      database,
      null,
      2
    ),
    'utf8'
  );

  fs.renameSync(
    temp,
    DB_FILE
  );
}


function getAccount(accountId) {

  return database.accounts[accountId] || null;
}


function createAccount(accountId) {

  const id =
    safeId(accountId);

  if (!id) {
    throw new Error(
      'Invalid account_id'
    );
  }

  if (!database.accounts[id]) {

    database.accounts[id] = {

      id,

      created_at: now(),

      updated_at: now(),

      enabled: true,

      phone: null,

      status: 'disconnected',

      connected: false,

      qr: null,

      qr_image: null,

      qr_expires_at: null,

      pairing_code: null,

      last_error: null,

      connected_at: null

    };

    saveDB();
  }

  return database.accounts[id];
}


// ============================================================
// SOCKET STORAGE
// ============================================================

const sessions =
  new Map();


/*
  sessions.set(accountId, {
    sock,
    state,
    saveCreds,
    reconnectTimer,
    connecting,
    bulkQueue,
    processingBulk
  });
*/


function getSession(accountId) {

  return sessions.get(accountId);
}


function getAuthPath(accountId) {

  return path.join(
    AUTH_DIR,
    accountId
  );
}


// ============================================================
// STATUS
// ============================================================

function publicAccount(account) {

  if (!account) {
    return null;
  }

  return {

    id: account.id,

    enabled: account.enabled,

    phone: account.phone,

    status: account.status,

    connected: account.connected,

    qr_available: !!account.qr,

    qr_expires_at:
      account.qr_expires_at,

    pairing_code:
      account.pairing_code,

    connected_at:
      account.connected_at,

    last_error:
      account.last_error,

    created_at:
      account.created_at,

    updated_at:
      account.updated_at
  };
}


function updateAccount(
  accountId,
  patch
) {

  const account =
    getAccount(accountId);

  if (!account) {
    return null;
  }

  Object.assign(
    account,
    patch,
    {
      updated_at: now()
    }
  );

  saveDB();

  return account;
}


// ============================================================
// CONNECT ACCOUNT
// ============================================================

async function connectAccount(accountId) {

  const id =
    safeId(accountId);

  if (!id) {
    throw new Error(
      'Invalid account_id'
    );
  }

  const account =
    createAccount(id);

  const existing =
    getSession(id);

  if (existing?.connecting) {
    return account;
  }

  if (
    existing?.sock &&
    account.connected
  ) {
    return account;
  }

  if (existing?.sock) {

    try {
      existing.sock.end(
        new Error(
          'Reconnecting'
        )
      );
    } catch (_) {}

    sessions.delete(id);
  }


  updateAccount(id, {

    status: 'connecting',

    connected: false,

    last_error: null,

    pairing_code: null
  });


  const authPath =
    getAuthPath(id);

  fs.mkdirSync(
    authPath,
    { recursive: true }
  );


  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      authPath
    );


  let version;

  try {

    const latest =
      await fetchLatestBaileysVersion();

    version =
      latest.version;

  } catch (error) {

    logger.warn(
      'Could not fetch latest Baileys version'
    );
  }


  const session = {

    sock: null,

    state,

    saveCreds,

    reconnectTimer: null,

    connecting: true,

    bulkQueue: [],

    processingBulk: false

  };


  sessions.set(
    id,
    session
  );


  const sock =
    makeWASocket({

      ...(version
        ? { version }
        : {}),

      auth: {

        creds: state.creds,

        keys:
          makeCacheableSignalKeyStore(
            state.keys,
            logger
          )

      },

      logger,

      markOnlineOnConnect: false,

      syncFullHistory: false,

      generateHighQualityLinkPreview: false,

      connectTimeoutMs: 60000,

      defaultQueryTimeoutMs: 60000

    });


  session.sock =
    sock;

  session.connecting =
    false;


  // ----------------------------------------------------------
  // SAVE AUTH
  // ----------------------------------------------------------

  sock.ev.on(
    'creds.update',
    async () => {

      try {

        await saveCreds();

      } catch (error) {

        logger.error({
          accountId: id,
          error
        }, 'Failed to save credentials');

      }

    }
  );


  // ----------------------------------------------------------
  // CONNECTION EVENTS
  // ----------------------------------------------------------

  sock.ev.on(
    'connection.update',
    async update => {

      const {
        connection,
        lastDisconnect,
        qr
      } = update;


      // QR received
      if (qr) {

        let qrImage = null;

        try {

          qrImage =
            await QRCode.toDataURL(
              qr,
              {
                width: 360,
                margin: 2
              }
            );

        } catch (error) {

          logger.error(error);

        }


        updateAccount(id, {

          status: 'qr',

          connected: false,

          qr,

          qr_image: qrImage,

          qr_expires_at:
            new Date(
              Date.now() +
              60000
            ).toISOString(),

          pairing_code: null

        });


        logger.info(
          `[${id}] QR generated`
        );
      }


      // Connection opened
      if (
        connection === 'open'
      ) {

        const me =
          sock.user;


        const phone =
          me?.id
            ?.split(':')[0]
            ?.split('@')[0]
          || null;


        updateAccount(id, {

          status: 'connected',

          connected: true,

          phone,

          qr: null,

          qr_image: null,

          qr_expires_at: null,

          pairing_code: null,

          last_error: null,

          connected_at: now()

        });


        logger.info(
          `[${id}] WhatsApp connected ${phone || ''}`
        );
      }


      // Connection closed
      if (
        connection === 'close'
      ) {

        const statusCode =
          new Boom(
            lastDisconnect?.error
          )?.output?.statusCode;


        const loggedOut =
          statusCode ===
          DisconnectReason.loggedOut;


        const connectionReplaced =
          statusCode ===
          DisconnectReason.connectionReplaced;


        updateAccount(id, {

          status:
            loggedOut
              ? 'logged_out'
              : 'disconnected',

          connected: false,

          last_error:
            lastDisconnect?.error
              ?.message ||
            `Connection closed (${statusCode || 'unknown'})`

        });


        logger.warn(
          `[${id}] Connection closed: ${statusCode || 'unknown'}`
        );


        /*
          Do not reconnect when WhatsApp explicitly logged
          the account out.
        */

        if (
          !loggedOut &&
          !connectionReplaced
        ) {

          scheduleReconnect(id);

        } else {

          sessions.delete(id);

        }
      }

    }
  );


  // ----------------------------------------------------------
  // INCOMING MESSAGES
  // ----------------------------------------------------------

  sock.ev.on(
    'messages.upsert',
    async event => {

      try {

        for (
          const message of
          event.messages || []
        ) {

          if (!message?.message) {
            continue;
          }

          const remoteJid =
            message.key?.remoteJid;

          if (!remoteJid) {
            continue;
          }

          const text =
            extractMessageText(
              message
            );

          logger.info({

            accountId: id,

            from:
              remoteJid,

            text

          }, 'Incoming WhatsApp message');

        }

      } catch (error) {

        logger.error(error);

      }

    }
  );


  return getAccount(id);
}


// ============================================================
// RECONNECT
// ============================================================

function scheduleReconnect(
  accountId
) {

  const session =
    getSession(accountId);

  if (!session) {
    return;
  }


  if (session.reconnectTimer) {
    return;
  }


  session.reconnectTimer =
    setTimeout(
      async () => {

        session.reconnectTimer =
          null;

        try {

          await connectAccount(
            accountId
          );

        } catch (error) {

          logger.error({
            accountId,
            error
          }, 'Reconnect failed');

          scheduleReconnect(
            accountId
          );
        }

      },

      5000
    );
}


// ============================================================
// EXTRACT MESSAGE TEXT
// ============================================================

function extractMessageText(
  message
) {

  const msg =
    message?.message;

  if (!msg) {
    return '';
  }

  return (

    msg.conversation ||

    msg.extendedTextMessage
      ?.text ||

    msg.imageMessage
      ?.caption ||

    msg.videoMessage
      ?.caption ||

    msg.documentMessage
      ?.caption ||

    ''

  );
}


// ============================================================
// QR
// ============================================================

async function getQR(
  accountId
) {

  const account =
    getAccount(accountId);

  if (!account) {
    throw new Error(
      'Account not found'
    );
  }

  return {

    qr:
      account.qr,

    qr_image:
      account.qr_image,

    expires_at:
      account.qr_expires_at

  };
}


// ============================================================
// PAIRING CODE
// ============================================================

async function requestPairingCode(
  accountId,
  phone
) {

  const normalized =
    normalizePhone(phone);

  if (!normalized) {
    throw new Error(
      'Invalid phone number'
    );
  }


  let session =
    getSession(accountId);


  if (!session?.sock) {

    await connectAccount(
      accountId
    );

    session =
      getSession(accountId);
  }


  if (!session?.sock) {
    throw new Error(
      'WhatsApp socket unavailable'
    );
  }


  if (
    session.state.creds.registered
  ) {

    throw new Error(
      'This account is already registered'
    );
  }


  const code =
    await session.sock
      .requestPairingCode(
        normalized
      );


  updateAccount(
    accountId,
    {
      status: 'pairing',

      pairing_code:
        code,

      qr: null,

      qr_image: null,

      qr_expires_at: null
    }
  );


  return code;
}


// ============================================================
// SEND TEXT
// ============================================================

async function sendText(
  accountId,
  phone,
  message
) {

  const account =
    getAccount(accountId);

  if (!account) {
    throw new Error(
      'Account not found'
    );
  }


  const session =
    getSession(accountId);


  if (
    !session?.sock ||
    !account.connected
  ) {

    throw new Error(
      'WhatsApp account is not connected'
    );
  }


  const text =
    String(message || '')
      .trim();


  if (!text) {
    throw new Error(
      'Message is required'
    );
  }


  if (
    text.length >
    MAX_MESSAGE_LENGTH
  ) {

    throw new Error(
      `Message too long. Maximum ${MAX_MESSAGE_LENGTH} characters`
    );
  }


  const jid =
    jidFromPhone(phone);


  const result =
    await session.sock.sendMessage(
      jid,
      {
        text
      }
    );


  return {

    jid,

    message_id:
      result?.key?.id || null,

    timestamp:
      result?.messageTimestamp || null

  };
}


// ============================================================
// SEND MEDIA BY URL
// ============================================================

async function sendMedia(
  accountId,
  phone,
  media
) {

  const account =
    getAccount(accountId);

  if (!account) {
    throw new Error(
      'Account not found'
    );
  }


  const session =
    getSession(accountId);


  if (
    !session?.sock ||
    !account.connected
  ) {

    throw new Error(
      'WhatsApp account is not connected'
    );
  }


  const jid =
    jidFromPhone(phone);


  const type =
    String(
      media.type || 'image'
    ).toLowerCase();


  const url =
    String(
      media.url || ''
    ).trim();


  if (!url) {
    throw new Error(
      'media.url is required'
    );
  }


  const caption =
    String(
      media.caption || ''
    );


  let content;


  if (type === 'image') {

    content = {

      image: {
        url
      },

      caption

    };

  } else if (
    type === 'video'
  ) {

    content = {

      video: {
        url
      },

      caption

    };

  } else if (
    type === 'audio'
  ) {

    content = {

      audio: {
        url
      },

      mimetype:
        media.mimetype ||
        'audio/mpeg',

      ptt:
        Boolean(media.ptt)

    };

  } else if (
    type === 'document'
  ) {

    content = {

      document: {
        url
      },

      mimetype:
        media.mimetype ||
        'application/octet-stream',

      fileName:
        media.filename ||
        'document'

    };

  } else {

    throw new Error(
      'Unsupported media type'
    );
  }


  const result =
    await session.sock.sendMessage(
      jid,
      content
    );


  return {

    jid,

    message_id:
      result?.key?.id || null,

    timestamp:
      result?.messageTimestamp || null

  };
}


// ============================================================
// BULK QUEUE
// ============================================================

async function createBulkJob(
  accountId,
  recipients,
  message,
  delayMs
) {

  const account =
    getAccount(accountId);

  if (!account) {
    throw new Error(
      'Account not found'
    );
  }


  if (!account.connected) {
    throw new Error(
      'Account is not connected'
    );
  }


  if (!Array.isArray(recipients)) {

    throw new Error(
      'recipients must be an array'
    );
  }


  if (
    recipients.length === 0
  ) {

    throw new Error(
      'No recipients'
    );
  }


  if (
    recipients.length >
    MAX_BULK_RECIPIENTS
  ) {

    throw new Error(
      `Maximum ${MAX_BULK_RECIPIENTS} recipients per job`
    );
  }


  const text =
    String(message || '')
      .trim();


  if (!text) {
    throw new Error(
      'Message is required'
    );
  }


  const delay =
    Math.max(
      Number(delayMs || DEFAULT_DELAY_MS),
      DEFAULT_DELAY_MS
    );


  const items =
    recipients.map(
      phone => {

        const normalized =
          normalizePhone(phone);

        if (!normalized) {
          return {

            phone:
              String(phone),

            status:
              'failed',

            error:
              'Invalid phone number'

          };
        }

        return {

          phone:
            normalized,

          status:
            'queued',

          error:
            null

        };

      }
    );


  const job = {

    id:
      randomId('bulk_'),

    account_id:
      accountId,

    message:
      text,

    delay_ms:
      delay,

    created_at:
      now(),

    started_at:
      null,

    completed_at:
      null,

    status:
      'queued',

    total:
      items.length,

    sent:
      0,

    failed:
      items.filter(
        x =>
          x.status ===
          'failed'
      ).length,

    items

  };


  const session =
    getSession(accountId);


  session.bulkQueue.push(
    job
  );


  processBulkQueue(
    accountId
  );


  return job;
}


// ============================================================
// BULK PROCESSOR
// ============================================================

async function processBulkQueue(
  accountId
) {

  const session =
    getSession(accountId);

  if (!session) {
    return;
  }


  if (
    session.processingBulk
  ) {
    return;
  }


  session.processingBulk =
    true;


  try {

    while (
      session.bulkQueue.length
    ) {

      const job =
        session.bulkQueue.shift();


      if (!job) {
        continue;
      }


      job.status =
        'running';

      job.started_at =
        now();


      logger.info({
        accountId,
        jobId: job.id,
        total: job.total
      }, 'Bulk job started');


      for (
        const item of job.items
      ) {

        if (
          item.status !==
          'queued'
        ) {
          continue;
        }


        try {

          const account =
            getAccount(accountId);


          if (
            !account ||
            !account.connected
          ) {

            throw new Error(
              'Account disconnected'
            );
          }


          const result =
            await sendText(
              accountId,
              item.phone,
              job.message
            );


          item.status =
            'sent';

          item.message_id =
            result.message_id;

          item.sent_at =
            now();

          job.sent++;

        } catch (error) {

          item.status =
            'failed';

          item.error =
            error.message;

          job.failed++;

        }


        /*
          Minimum delay between recipients.
          This is intentionally conservative.
        */

        await sleep(
          job.delay_ms
        );

      }


      job.status =
        'completed';

      job.completed_at =
        now();


      logger.info({
        accountId,
        jobId: job.id,
        sent: job.sent,
        failed: job.failed
      }, 'Bulk job completed');

    }

  } finally {

    session.processingBulk =
      false;

  }
}


// ============================================================
// AUTH MIDDLEWARE
// ============================================================

function authenticate(
  req,
  res,
  next
) {

  const supplied =
    req.headers['x-connector-token'] ||
    req.headers.authorization
      ?.replace(/^Bearer\s+/i, '');


  if (
    !supplied ||
    supplied !== API_TOKEN
  ) {

    return fail(
      res,
      401,
      'Unauthorized'
    );
  }


  next();
}


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  (req, res) => {

    return ok(
      res,
      {
        service:
          'RB WhatsApp Multi-Account Connector',

        version:
          '3.0.0',

        uptime:
          process.uptime(),

        accounts:
          Object.keys(
            database.accounts
          ).length,

        active_sessions:
          sessions.size,

        time:
          now()
      }
    );

  }
);


// ============================================================
// ALL API ROUTES REQUIRE TOKEN
// ============================================================

app.use(
  '/api',
  authenticate
);


// ============================================================
// LIST ACCOUNTS
// ============================================================

app.get(
  '/api/accounts',
  (req, res) => {

    const accounts =
      Object.values(
        database.accounts
      )
      .map(publicAccount);


    return ok(
      res,
      {
        accounts
      }
    );

  }
);


// ============================================================
// CREATE ACCOUNT
// ============================================================

app.post(
  '/api/accounts',
  (req, res) => {

    try {

      const accountId =
        safeId(
          req.body.account_id
        );


      if (!accountId) {

        return fail(
          res,
          400,
          'account_id is required'
        );
      }


      const account =
        createAccount(
          accountId
        );


      return ok(
        res,
        {
          account:
            publicAccount(
              account
            )
        }
      );

    } catch (error) {

      return fail(
        res,
        400,
        error.message
      );

    }

  }
);


// ============================================================
// ACCOUNT STATUS
// ============================================================

app.get(
  '/api/accounts/:id/status',
  (req, res) => {

    const id =
      safeId(
        req.params.id
      );


    const account =
      getAccount(id);


    if (!account) {

      return fail(
        res,
        404,
        'Account not found'
      );
    }


    return ok(
      res,
      {
        account:
          publicAccount(
            account
          )
      }
    );

  }
);


// ============================================================
// CONNECT
// ============================================================

app.post(
  '/api/accounts/:id/connect',
  async (req, res) => {

    try {

      const id =
        safeId(
          req.params.id
        );


      if (!id) {

        return fail(
          res,
          400,
          'Invalid account_id'
        );
      }


      await connectAccount(id);


      return ok(
        res,
        {
          account:
            publicAccount(
              getAccount(id)
            )
        }
      );

    } catch (error) {

      logger.error(error);

      return fail(
        res,
        500,
        error.message
      );

    }

  }
);


// ============================================================
// QR
// ============================================================

app.get(
  '/api/accounts/:id/qr',
  async (req, res) => {

    try {

      const id =
        safeId(
          req.params.id
        );


      const qr =
        await getQR(id);


      return ok(
        res,
        qr
      );

    } catch (error) {

      return fail(
        res,
        404,
        error.message
      );

    }

  }
);


// ============================================================
// PAIRING CODE
// ============================================================

app.post(
  '/api/accounts/:id/pair',
  async (req, res) => {

    try {

      const id =
        safeId(
          req.params.id
        );


      const phone =
        normalizePhone(
          req.body.phone
        );


      if (!phone) {

        return fail(
          res,
          400,
          'Valid phone is required'
        );
      }


      const code =
        await requestPairingCode(
          id,
          phone
        );


      return ok(
        res,
        {
          pairing_code:
            code
        }
      );

    } catch (error) {

      return fail(
        res,
        400,
        error.message
      );

    }

  }
);


// ============================================================
// DISCONNECT
// ============================================================

app.post(
  '/api/accounts/:id/disconnect',
  async (req, res) => {

    const id =
      safeId(
        req.params.id
      );


    const account =
      getAccount(id);


    if (!account) {

      return fail(
        res,
        404,
        'Account not found'
      );
    }


    const session =
      getSession(id);


    try {

      if (session?.sock) {

        await session.sock.logout();

      }

    } catch (error) {

      logger.warn(error);

    }


    sessions.delete(id);


    updateAccount(id, {

      status:
        'disconnected',

      connected:
        false,

      qr:
        null,

      qr_image:
        null,

      pairing_code:
        null

    });


    return ok(
      res,
      {
        account:
          publicAccount(
            getAccount(id)
          )
      }
    );

  }
);


// ============================================================
// RESET ACCOUNT
// ============================================================

app.post(
  '/api/accounts/:id/reset',
  async (req, res) => {

    const id =
      safeId(
        req.params.id
      );


    const account =
      getAccount(id);


    if (!account) {

      return fail(
        res,
        404,
        'Account not found'
      );
    }


    const session =
      getSession(id);


    try {

      if (session?.sock) {

        try {
          await session.sock.logout();
        } catch (_) {}

        try {
          session.sock.end(
            new Error(
              'Reset'
            )
          );
        } catch (_) {}

      }

    } catch (_) {}


    sessions.delete(id);


    const authPath =
      getAuthPath(id);


    /*
      Delete only this account's session.
    */

    if (
      fs.existsSync(authPath)
    ) {

      fs.rmSync(
        authPath,
        {
          recursive: true,
          force: true
        }
      );

    }


    updateAccount(id, {

      status:
        'disconnected',

      connected:
        false,

      phone:
        null,

      qr:
        null,

      qr_image:
        null,

      qr_expires_at:
        null,

      pairing_code:
        null,

      last_error:
        null,

      connected_at:
        null

    });


    return ok(
      res,
      {
        message:
          'Account session reset'
      }
    );

  }
);


// ============================================================
// DELETE ACCOUNT
// ============================================================

app.delete(
  '/api/accounts/:id',
  async (req, res) => {

    const id =
      safeId(
        req.params.id
      );


    if (
      !database.accounts[id]
    ) {

      return fail(
        res,
        404,
        'Account not found'
      );
    }


    const session =
      getSession(id);


    try {

      if (session?.sock) {

        try {
          await session.sock.logout();
        } catch (_) {}

      }

    } catch (_) {}


    sessions.delete(id);


    const authPath =
      getAuthPath(id);


    if (
      fs.existsSync(authPath)
    ) {

      fs.rmSync(
        authPath,
        {
          recursive: true,
          force: true
        }
      );

    }


    delete database.accounts[id];

    saveDB();


    return ok(
      res,
      {
        message:
          'Account deleted'
      }
    );

  }
);


// ============================================================
// SEND TEXT
// ============================================================

app.post(
  '/api/send-message',
  async (req, res) => {

    try {

      const accountId =
        safeId(
          req.body.account_id
        );


      const phone =
        req.body.phone;


      const message =
        req.body.message;


      if (!accountId) {

        return fail(
          res,
          400,
          'account_id is required'
        );
      }


      const result =
        await sendText(
          accountId,
          phone,
          message
        );


      return ok(
        res,
        result
      );

    } catch (error) {

      return fail(
        res,
        400,
        error.message
      );

    }

  }
);


// ============================================================
// SEND MEDIA
// ============================================================

app.post(
  '/api/send-media',
  async (req, res) => {

    try {

      const accountId =
        safeId(
          req.body.account_id
        );


      const result =
        await sendMedia(
          accountId,
          req.body.phone,
          {
            type:
              req.body.type,

            url:
              req.body.url,

            caption:
              req.body.caption,

            filename:
              req.body.filename,

            mimetype:
              req.body.mimetype,

            ptt:
              req.body.ptt
          }
        );


      return ok(
        res,
        result
      );

    } catch (error) {

      return fail(
        res,
        400,
        error.message
      );

    }

  }
);


// ============================================================
// BULK CREATE
// ============================================================

app.post(
  '/api/bulk',
  async (req, res) => {

    try {

      /*
        Example:

        {
          "account_id": "account1",
          "recipients": [
            "919876543210",
            "919123456789"
          ],
          "message": "Hello",
          "delay_ms": 2000
        }
      */

      const accountId =
        safeId(
          req.body.account_id
        );


      const job =
        await createBulkJob(
          accountId,

          req.body.recipients,

          req.body.message,

          req.body.delay_ms
        );


      return ok(
        res,
        {
          job_id:
            job.id,

          status:
            job.status,

          total:
            job.total
        }
      );

    } catch (error) {

      return fail(
        res,
        400,
        error.message
      );

    }

  }
);


// ============================================================
// BULK STATUS
// ============================================================

app.get(
  '/api/bulk/:jobId',
  (req, res) => {

    const jobId =
      req.params.jobId;


    let found = null;


    for (
      const session
      of sessions.values()
    ) {

      const queued =
        session.bulkQueue
          .find(
            job =>
              job.id === jobId
          );


      if (queued) {

        found =
          queued;

        break;
      }

    }


    if (!found) {

      return fail(
        res,
        404,
        'Job not found or already completed'
      );

    }


    return ok(
      res,
      {
        job:
          found
      }
    );

  }
);


// ============================================================
// START EXISTING SESSIONS
// ============================================================

async function restoreSessions() {

  const accounts =
    Object.values(
      database.accounts
    );


  for (
    const account
    of accounts
  ) {

    if (
      account.enabled === false
    ) {
      continue;
    }


    /*
      Small delay between accounts
      so a restart doesn't open every
      socket at exactly the same time.
    */

    await sleep(1000);


    try {

      await connectAccount(
        account.id
      );

    } catch (error) {

      logger.error({
        accountId:
          account.id,

        error

      }, 'Failed to restore account');

    }

  }

}


// ============================================================
// ROOT
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.json({

      success: true,

      service:
        'RB WhatsApp Multi-Account Connector',

      version:
        '3.0.0',

      endpoints: {

        health:
          'GET /health',

        accounts:
          'GET /api/accounts',

        create_account:
          'POST /api/accounts',

        connect:
          'POST /api/accounts/:id/connect',

        qr:
          'GET /api/accounts/:id/qr',

        pairing:
          'POST /api/accounts/:id/pair',

        status:
          'GET /api/accounts/:id/status',

        disconnect:
          'POST /api/accounts/:id/disconnect',

        reset:
          'POST /api/accounts/:id/reset',

        delete:
          'DELETE /api/accounts/:id',

        send:
          'POST /api/send-message',

        media:
          'POST /api/send-media',

        bulk:
          'POST /api/bulk',

        bulk_status:
          'GET /api/bulk/:jobId'

      }

    });

  }
);


// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (err, req, res, next) => {

    logger.error(err);

    return fail(
      res,
      500,
      'Internal server error'
    );

  }
);


// ============================================================
// SERVER
// ============================================================

app.listen(
  PORT,
  async () => {

    logger.info(
      `RB WhatsApp connector running on port ${PORT}`
    );

    logger.info(
      `Accounts directory: ${AUTH_DIR}`
    );


    await restoreSessions();

  }
);


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(
  signal
) {

  logger.info(
    `${signal}: shutting down`
  );


  for (
    const [
      accountId,
      session
    ]
    of sessions.entries()
  ) {

    try {

      if (
        session.reconnectTimer
      ) {

        clearTimeout(
          session.reconnectTimer
        );

      }


      if (
        session.sock
      ) {

        session.sock.end(
          new Error(
            'Server shutdown'
          )
        );

      }

    } catch (error) {

      logger.error({
        accountId,
        error
      });

    }

  }


  process.exit(0);

}


process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);
