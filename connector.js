
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
  String(
    process.env.HOST || '0.0.0.0'
  );

const DEFAULT_COUNTRY =
  String(
    process.env.DEFAULT_COUNTRY || '91'
  )
    .replace(/\D/g, '') || '91';

const AUTH_DIR =
  path.resolve(
    process.env.AUTH_DIR || './auth_info'
  );

const DATA_DIR =
  path.resolve(
    process.env.DATA_DIR || './data'
  );

const QR_TTL_MS =
  Number(
    process.env.QR_TTL_MS || 300000
  );

const LOG_LEVEL =
  process.env.LOG_LEVEL || 'info';

const JSON_LIMIT =
  process.env.JSON_LIMIT || '5mb';

const RECONNECT_DELAY_MS =
  Number(
    process.env.RECONNECT_DELAY_MS || 5000
  );

const MAX_RECONNECT_DELAY_MS =
  Number(
    process.env.MAX_RECONNECT_DELAY_MS || 60000
  );

const IDLE_TIMEOUT_MS =
  Number(
    process.env.IDLE_TIMEOUT_MS || 300000
  );


/* ============================================================
   OPENAI
   ============================================================ */

const OPENAI_ENABLED =
  String(
    process.env.OPENAI_ENABLED ?? 'true'
  ).toLowerCase() !== 'false';

const OPENAI_MODEL =
  String(
    process.env.OPENAI_MODEL || 'gpt-6-luna'
  );

const OPENAI_BASE_URL =
  String(
    process.env.OPENAI_BASE_URL ||
    'https://api.openai.com/v1'
  )
    .replace(/\/+$/, '');

const OPENAI_TIMEOUT_MS =
  Number(
    process.env.OPENAI_TIMEOUT_MS || 30000
  );

const AI_MAX_OUTPUT_TOKENS =
  Number(
    process.env.AI_MAX_OUTPUT_TOKENS || 500
  );

const AI_MAX_HISTORY =
  Number(
    process.env.AI_MAX_HISTORY || 12
  );

const AI_SYSTEM_PROMPT =
  String(
    process.env.AI_SYSTEM_PROMPT ||
    [
      'You are Ripun Baruah replying on WhatsApp.',
      'Reply naturally and helpfully like a real person.',
      'Keep replies concise unless the user asks for detail.',
      'Do not mention that you are an AI unless the user directly asks.',
      'Use the same language and tone as the incoming message when practical.',
      'Do not invent personal facts about Ripun.',
      'If you do not know something, say so briefly.'
    ].join(' ')
  );


/*
 * Multiple API keys.
 *
 * OPENAI_API_KEY_1
 * OPENAI_API_KEY_2
 * OPENAI_API_KEY_3
 *
 * Up to 50 supported.
 */

const AI_KEYS = [];

for (
  let i = 1;
  i <= 50;
  i += 1
) {

  const value =
    String(
      process.env[`OPENAI_API_KEY_${i}`] || ''
    ).trim();

  if (value) {
    AI_KEYS.push(value);
  }

}


/*
 * Backward-compatible single key.
 */

if (
  !AI_KEYS.length &&
  process.env.OPENAI_API_KEY
) {

  AI_KEYS.push(
    String(
      process.env.OPENAI_API_KEY
    ).trim()
  );

}


let openAIKeyIndex = 0;


/* ============================================================
   AUTO REPLY
   ============================================================ */

const AUTO_REPLY_DEFAULT_ENABLED =
  String(
    process.env.AUTO_REPLY_ENABLED ?? 'true'
  ).toLowerCase() !== 'false';

const AUTO_AI_NEW_USERS =
  String(
    process.env.AUTO_AI_NEW_USERS ?? 'true'
  ).toLowerCase() !== 'false';


const ENV_AI_ONLY_NUMBERS =
  String(
    process.env.AI_ONLY_NUMBERS || ''
  )
    .split(',')
    .map(
      x => x.trim()
    )
    .filter(Boolean);


const DEFAULT_WELCOME_TEXT =
  String(
    process.env.WELCOME_TEXT ||
    'Hi! 👋 Thanks for messaging Ripun Baruah. I’ll get back to you soon.'
  );


const DEFAULT_BUSY_TEXT =
  String(
    process.env.BUSY_TEXT ||
    'Hi! I’m currently busy. Please leave your message and I’ll get back to you as soon as possible. 😊'
  );


const WELCOME_DEFAULT_ENABLED =
  String(
    process.env.WELCOME_ENABLED ?? 'true'
  ).toLowerCase() !== 'false';


const BUSY_DEFAULT_ENABLED =
  String(
    process.env.BUSY_ENABLED ?? 'false'
  ).toLowerCase() === 'true';


const BUSY_MODE =
  String(
    process.env.BUSY_MODE || 'before_ai'
  ).toLowerCase();


const REPLY_TO_MEDIA =
  String(
    process.env.REPLY_TO_MEDIA ?? 'false'
  ).toLowerCase() === 'true';


const TYPING_BEFORE_AI =
  String(
    process.env.TYPING_BEFORE_AI ?? 'true'
  ).toLowerCase() !== 'false';


const TYPING_MIN_MS =
  Number(
    process.env.TYPING_MIN_MS || 400
  );


const TYPING_MAX_MS =
  Number(
    process.env.TYPING_MAX_MS || 1400
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

app.disable(
  'x-powered-by'
);


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
   ACCOUNT HELPERS
   ============================================================ */

function cleanAccountId(
  value
) {

  const id =
    String(
      value || ''
    ).trim();


  if (!id) {
    return 'user1';
  }


  const safe =
    id
      .replace(
        /[^a-zA-Z0-9_-]/g,
        ''
      )
      .slice(
        0,
        64
      );


  return safe || 'user1';

}


function accountIdFromRequest(
  req
) {

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


function authPath(
  account
) {

  return path.join(
    AUTH_DIR,
    account
  );

}


function dataPath(
  account
) {

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


function autoReplyPath(
  account
) {

  return path.join(
    dataPath(account),
    'auto-reply.json'
  );

}


function historyPath(
  account
) {

  return path.join(
    dataPath(account),
    'ai-history.json'
  );

}


/* ============================================================
   JSON STORAGE
   ============================================================ */

function safeReadJson(
  file,
  fallback
) {

  try {

    if (
      !fs.existsSync(file)
    ) {

      return fallback;

    }


    const parsed =
      JSON.parse(
        fs.readFileSync(
          file,
          'utf8'
        )
      );


    return (
      parsed &&
      typeof parsed === 'object'
    )
      ? parsed
      : fallback;


  } catch (err) {

    logger.warn(
      {
        file,
        err: String(err)
      },
      'JSON read failed'
    );


    return fallback;

  }

}


function safeWriteJson(
  file,
  value
) {

  const tmp =
    `${file}.tmp`;


  fs.writeFileSync(
    tmp,
    JSON.stringify(
      value,
      null,
      2
    ),
    'utf8'
  );


  fs.renameSync(
    tmp,
    file
  );

}


/* ============================================================
   PHONE
   ============================================================ */

function normalizePhone(
  input
) {

  let value =
    String(
      input || ''
    ).trim();


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


function jidForPhone(
  phone
) {

  return (
    normalizePhone(phone) +
    '@s.whatsapp.net'
  );

}


function extractPhoneFromJid(
  jid
) {

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


function isGroupJid(
  jid
) {

  return String(
    jid || ''
  ).endsWith(
    '@g.us'
  );

}


function isBroadcastJid(
  jid
) {

  return (
    String(jid || '') ===
    'status@broadcast'
  );

}


/* ============================================================
   AUTO REPLY CONFIG
   ============================================================ */

function defaultAutoReplyConfig() {

  return {

    enabled:
      AUTO_REPLY_DEFAULT_ENABLED,

    ai_enabled:
      OPENAI_ENABLED,

    ai_new_users:
      AUTO_AI_NEW_USERS,

    ai_only_numbers:
      ENV_AI_ONLY_NUMBERS
        .map(
          x => {

            try {

              return normalizePhone(x);

            } catch (_) {

              return null;

            }

          }
        )
        .filter(Boolean),

    welcome_enabled:
      WELCOME_DEFAULT_ENABLED,

    welcome_text:
      DEFAULT_WELCOME_TEXT,

    busy_enabled:
      BUSY_DEFAULT_ENABLED,

    busy_text:
      DEFAULT_BUSY_TEXT,

    busy_mode:
      BUSY_MODE,

    ai_all_messages:
      true,

    reply_to_media:
      REPLY_TO_MEDIA,

    system_prompt:
      AI_SYSTEM_PROMPT,

    max_history:
      AI_MAX_HISTORY

  };

}


function normalizeConfig(
  account
) {

  const current =
    safeReadJson(
      autoReplyPath(account),
      defaultAutoReplyConfig()
    );


  const defaults =
    defaultAutoReplyConfig();


  const cfg = {
    ...defaults,
    ...current
  };


  if (
    !Array.isArray(
      cfg.ai_only_numbers
    )
  ) {

    cfg.ai_only_numbers = [];

  }


  cfg.ai_only_numbers =
    [
      ...new Set(

        cfg.ai_only_numbers
          .map(
            x => {

              try {

                return normalizePhone(x);

              } catch (_) {

                return null;

              }

            }
          )
          .filter(Boolean)

      )
    ];


  if (
    !Number.isFinite(
      Number(
        cfg.max_history
      )
    )
  ) {

    cfg.max_history =
      AI_MAX_HISTORY;

  }


  return cfg;

}


function saveConfig(
  account,
  cfg
) {

  const normalized = {

    ...defaultAutoReplyConfig(),

    ...cfg,

    ai_only_numbers:
      [
        ...new Set(

          (
            Array.isArray(
              cfg.ai_only_numbers
            )
              ? cfg.ai_only_numbers
              : []
          )
            .map(
              x => {

                try {

                  return normalizePhone(x);

                } catch (_) {

                  return null;

                }

              }
            )
            .filter(Boolean)

        )
      ]

  };


  safeWriteJson(
    autoReplyPath(account),
    normalized
  );


  return normalized;

}


/* ============================================================
   AI HISTORY
   ============================================================ */

function loadHistory(
  account
) {

  return safeReadJson(
    historyPath(account),
    {}
  );

}


function saveHistory(
  account,
  history
) {

  safeWriteJson(
    historyPath(account),
    history
  );

}


/* ============================================================
   ACCOUNT STATE
   ============================================================ */

function createAccountState(
  account
) {

  if (
    !accounts.has(account)
  ) {

    accounts.set(
      account,
      {

        id:
          account,

        sock:
          null,

        connecting:
          false,

        connected:
          false,

        status:
          'disconnected',

        phone:
          null,

        jid:
          null,

        qr:
          null,

        qrImage:
          null,

        qrCreatedAt:
          null,

        qrExpiresAt:
          null,

        pairingCode:
          null,

        pairingCreatedAt:
          null,

        connectedAt:
          null,

        lastDisconnect:
          null,

        lastError:
          null,

        reconnectTimer:
          null,

        reconnectDelay:
          RECONNECT_DELAY_MS,

        generation:
          0,

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
          0,

        aiReplies:
          0,

        aiErrors:
          0

      }
    );

  }


  return accounts.get(
    account
  );

}


/* ============================================================
   REPLIED USERS
   ============================================================ */

function loadRepliedUsers(
  account
) {

  return safeReadJson(
    path.join(
      dataPath(account),
      'replied-users.json'
    ),
    {}
  );

}


function markFirstReplySent(
  state,
  phone
) {

  state.repliedUsers[
    phone
  ] = {

    replied_at:
      new Date()
        .toISOString()

  };


  safeWriteJson(
    path.join(
      dataPath(state.id),
      'replied-users.json'
    ),
    state.repliedUsers
  );

}


/* ============================================================
   QR
   ============================================================ */

function clearQR(
  state
) {

  state.qr =
    null;

  state.qrImage =
    null;

  state.qrCreatedAt =
    null;

  state.qrExpiresAt =
    null;

}


function clearPairing(
  state
) {

  state.pairingCode =
    null;

  state.pairingCreatedAt =
    null;

}


function qrIsValid(
  state
) {

  return Boolean(

    state.qr &&

    state.qrImage &&

    state.qrExpiresAt &&

    Date.now() <
      state.qrExpiresAt

  );

}


/* ============================================================
   PRESENCE
   ============================================================ */

function clearIdleTimer(
  state
) {

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


async function setAvailable(
  state
) {

  if (
    !state.sock ||
    !state.connected
  ) {

    return;

  }


  try {

    await state.sock
      .sendPresenceUpdate(
        'available'
      );


    state.isAvailable =
      true;


  } catch (err) {

    logger.debug(
      {
        account:
          state.id,

        err:
          String(err)

      },
      'Could not set available presence'
    );

  }

}


async function setUnavailable(
  state
) {

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


  } catch (err) {

    logger.debug(
      {
        account:
          state.id,

        err:
          String(err)

      },
      'Could not set unavailable presence'
    );

  }

}


function scheduleIdlePresence(
  state
) {

  clearIdleTimer(
    state
  );


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


async function markActive(
  state
) {

  state.lastActivity =
    Date.now();


  await setAvailable(
    state
  );


  scheduleIdlePresence(
    state
  );

}


/* ============================================================
   MESSAGE EXTRACTION
   ============================================================ */

function getMessageText(
  message
) {

  const m =
    message?.message;


  if (!m) {
    return '';
  }


  return (

    m.conversation ||

    m.extendedTextMessage?.text ||

    m.imageMessage?.caption ||

    m.videoMessage?.caption ||

    m.documentMessage?.caption ||

    m.buttonsResponseMessage
      ?.selectedDisplayText ||

    m.listResponseMessage
      ?.title ||

    m.templateButtonReplyMessage
      ?.selectedDisplayText ||

    m.interactiveResponseMessage
      ?.body?.text ||

    ''

  ).trim();

}


/* ============================================================
   AUTO REPLY STATE
   ============================================================ */

function getAutoReplyState(
  account,
  phone
) {

  const cfg =
    normalizeConfig(
      account
    );


  const isAiOnly =
    cfg.ai_only_numbers
      .includes(phone);


  const state =
    createAccountState(
      account
    );


  const isNewUser =
    !state.repliedUsers[
      phone
    ];


  return {

    cfg,

    isAiOnly,

    isNewUser

  };

}


/* ============================================================
   GENERAL HELPERS
   ============================================================ */

function sleep(
  ms
) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );

}


function randomBetween(
  min,
  max
) {

  const a =
    Math.max(
      0,
      Number(min) || 0
    );


  const b =
    Math.max(
      a,
      Number(max) || a
    );


  return Math.floor(
    a +
    Math.random() *
      (b - a + 1)
  );

}


/* ============================================================
   TYPING
   ============================================================ */

async function maybeTyping(
  state,
  jid
) {

  if (
    !TYPING_BEFORE_AI ||
    !state.sock ||
    !state.connected
  ) {

    return;

  }


  try {

    await state.sock
      .sendPresenceUpdate(
        'composing',
        jid
      );


    await sleep(
      randomBetween(
        TYPING_MIN_MS,
        TYPING_MAX_MS
      )
    );


    await state.sock
      .sendPresenceUpdate(
        'paused',
        jid
      );


  } catch (_) {}

}


/* ============================================================
   OPENAI KEY ROTATION
   ============================================================ */

function getNextOpenAIKey() {

  if (
    !AI_KEYS.length
  ) {

    return null;

  }


  const key =
    AI_KEYS[
      openAIKeyIndex %
      AI_KEYS.length
    ];


  openAIKeyIndex =
    (
      openAIKeyIndex + 1
    ) %
    AI_KEYS.length;


  return key;

}


function isRetryableOpenAIStatus(
  status
) {

  return (

    status === 401 ||

    status === 408 ||

    status === 409 ||

    status === 429 ||

    status >= 500

  );

}


/* ============================================================
   OPENAI REQUEST
   ============================================================ */

async function openAIRequest(
  body,
  key
) {

  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      OPENAI_TIMEOUT_MS
    );


  try {

    const response =
      await fetch(

        `${OPENAI_BASE_URL}/responses`,

        {

          method:
            'POST',

          headers: {

            'Content-Type':
              'application/json',

            Authorization:
              `Bearer ${key}`

          },

          body:
            JSON.stringify(
              body
            ),

          signal:
            controller.signal

        }

      );


    const raw =
      await response.text();


    let json;


    try {

      json =
        JSON.parse(
          raw
        );

    } catch (_) {

      json = {
        raw
      };

    }


    if (
      !response.ok
    ) {

      const error =
        new Error(

          json?.error?.message ||

          json?.message ||

          `OpenAI HTTP ${response.status}`

        );


      error.status =
        response.status;


      error.openai =
        json;


      throw error;

    }


    return json;


  } finally {

    clearTimeout(
      timer
    );

  }

}


/* ============================================================
   OPENAI OUTPUT
   ============================================================ */

function extractOpenAIText(
  response
) {

  if (
    typeof response?.output_text ===
    'string'
  ) {

    return response
      .output_text
      .trim();

  }


  const chunks =
    [];


  for (
    const item of
    response?.output || []
  ) {

    for (
      const content of
      item?.content || []
    ) {

      if (
        typeof content?.text ===
        'string'
      ) {

        chunks.push(
          content.text
        );

      }

    }

  }


  return chunks
    .join('\n')
    .trim();

}


/* ============================================================
   GENERATE AI REPLY
   ============================================================ */

async function generateAIReply({

  account,

  phone,

  userText,

  cfg

}) {

  if (
    !OPENAI_ENABLED ||
    !cfg.ai_enabled
  ) {

    throw new Error(
      'AI auto reply is disabled'
    );

  }


  if (
    !AI_KEYS.length
  ) {

    throw new Error(
      'No OpenAI API key configured. Set OPENAI_API_KEY_1, OPENAI_API_KEY_2, etc.'
    );

  }


  const history =
    loadHistory(
      account
    );


  const conversation =
    Array.isArray(
      history[phone]
    )
      ? history[phone]
      : [];


  const maxHistory =
    Math.max(
      2,
      Math.min(
        50,
        Number(
          cfg.max_history
        ) ||
        AI_MAX_HISTORY
      )
    );


  const recent =
    conversation.slice(
      -maxHistory
    );


  const body = {

    model:
      OPENAI_MODEL,

    instructions:
      String(
        cfg.system_prompt ||
        AI_SYSTEM_PROMPT
      ),

    input:

      [

        ...recent.map(
          item => ({

            role:
              item.role,

            content:
              item.text

          })
        ),

        {

          role:
            'user',

          content:
            userText

        }

      ],

    max_output_tokens:
      AI_MAX_OUTPUT_TOKENS

  };


  let lastError =
    null;


  for (
    let attempt = 0;
    attempt < AI_KEYS.length;
    attempt += 1
  ) {

    const key =
      getNextOpenAIKey();


    try {

      const response =
        await openAIRequest(
          body,
          key
        );


      const answer =
        extractOpenAIText(
          response
        );


      if (!answer) {

        throw new Error(
          'OpenAI returned an empty response'
        );

      }


      const nextHistory =

        [

          ...recent,

          {
            role:
              'user',

            text:
              userText
          },

          {
            role:
              'assistant',

            text:
              answer
          }

        ]
          .slice(
            -maxHistory
          );


      history[phone] =
        nextHistory;


      saveHistory(
        account,
        history
      );


      return answer;


    } catch (err) {

      lastError =
        err;


      logger.warn(
        {

          account,

          phone,

          status:
            err?.status ||
            null,

          key_slot:
            (
              (
                openAIKeyIndex -
                1 +
                AI_KEYS.length
              ) %
              AI_KEYS.length
            ) + 1,

          err:
            String(
              err?.message ||
              err
            )

        },

        'OpenAI request failed'
      );


      if (
        !isRetryableOpenAIStatus(
          err?.status
        )
      ) {

        break;

      }

    }

  }


  throw (
    lastError ||
    new Error(
      'OpenAI request failed'
    )
  );

}


/* ============================================================
   SEND TEXT
   ============================================================ */

async function sendText(
  state,
  phone,
  text
) {

  const jid =
    jidForPhone(
      phone
    );


  await state.sock
    .sendMessage(
      jid,
      {
        text
      }
    );


  state.outgoingMessages +=
    1;


  return jid;

}


/* ============================================================
   INCOMING MESSAGE
   ============================================================ */

async function processIncomingMessage(
  state,
  message
) {

  try {

    if (
      !state.connected ||
      !state.sock
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


    if (
      isGroupJid(
        remoteJid
      )
    ) {

      return;

    }


    if (
      isBroadcastJid(
        remoteJid
      )
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


    state.incomingMessages +=
      1;


    /*
     * IMPORTANT:
     *
     * As soon as a message arrives,
     * make WhatsApp account available/online.
     */

    await markActive(
      state
    );


    const {

      cfg,

      isAiOnly,

      isNewUser

    } =
      getAutoReplyState(
        state.id,
        phone
      );


    if (
      !cfg.enabled
    ) {

      return;

    }


    const text =
      getMessageText(
        message
      );


    const hasText =
      Boolean(
        text
      );


    if (
      !hasText &&
      !cfg.reply_to_media
    ) {

      return;

    }


    /* ========================================================
       AI ONLY NUMBER
       ======================================================== */

    if (
      isAiOnly
    ) {

      if (!hasText) {
        return;
      }


      try {

        await maybeTyping(
          state,
          remoteJid
        );


        const answer =
          await generateAIReply({

            account:
              state.id,

            phone,

            userText:
              text,

            cfg

          });


        await sendText(
          state,
          phone,
          answer
        );


        state.autoReplies +=
          1;


        state.aiReplies +=
          1;


        markFirstReplySent(
          state,
          phone
        );


        logger.info(
          {
            account:
              state.id,

            phone
          },
          'AI-only reply sent'
        );


      } catch (err) {

        state.aiErrors +=
          1;


        state.lastError =
          String(
            err?.message ||
            err
          );


        logger.error(
          {

            account:
              state.id,

            phone,

            err:
              String(
                err?.message ||
                err
              )

          },

          'AI-only reply failed'
        );

      }


      return;

    }


    /* ========================================================
       NEW USER WELCOME
       ======================================================== */

    if (
      isNewUser &&
      cfg.welcome_enabled
    ) {

      try {

        await sendText(
          state,
          phone,
          String(
            cfg.welcome_text ||
            DEFAULT_WELCOME_TEXT
          )
        );


        state.autoReplies +=
          1;


      } catch (err) {

        logger.warn(
          {

            account:
              state.id,

            phone,

            err:
              String(err)

          },

          'Welcome message failed'
        );

      }

    }


    /* ========================================================
       BUSY INSTEAD OF AI
       ======================================================== */

    if (

      cfg.busy_enabled &&

      String(
        cfg.busy_mode
      ).toLowerCase() ===
      'instead'

    ) {

      try {

        await sendText(
          state,
          phone,
          String(
            cfg.busy_text ||
            DEFAULT_BUSY_TEXT
          )
        );


        state.autoReplies +=
          1;


        markFirstReplySent(
          state,
          phone
        );


      } catch (err) {

        logger.warn(
          {

            account:
              state.id,

            phone,

            err:
              String(err)

          },

          'Busy message failed'
        );

      }


      return;

    }


    /* ========================================================
       BUSY + AI
       ======================================================== */

    if (
      cfg.busy_enabled
    ) {

      try {

        await sendText(
          state,
          phone,
          String(
            cfg.busy_text ||
            DEFAULT_BUSY_TEXT
          )
        );


        state.autoReplies +=
          1;


      } catch (err) {

        logger.warn(
          {

            account:
              state.id,

            phone,

            err:
              String(err)

          },

          'Busy message failed'
        );

      }

    }


    /* ========================================================
       AI
       ======================================================== */

    const shouldAI =

      cfg.ai_enabled &&

      cfg.ai_all_messages &&

      (
        hasText ||
        cfg.reply_to_media
      ) &&

      (
        cfg.ai_new_users ||
        !isNewUser
      );


    if (
      !shouldAI
    ) {

      if (
        isNewUser
      ) {

        markFirstReplySent(
          state,
          phone
        );

      }


      return;

    }


    if (!hasText) {
      return;
    }


    try {

      await maybeTyping(
        state,
        remoteJid
      );


      const answer =
        await generateAIReply({

          account:
            state.id,

          phone,

          userText:
            text,

          cfg

        });


      await sendText(
        state,
        phone,
        answer
      );


      state.autoReplies +=
        1;


      state.aiReplies +=
        1;


      markFirstReplySent(
        state,
        phone
      );


      logger.info(
        {

          account:
            state.id,

          phone

        },

        'AI auto reply sent'
      );


    } catch (err) {

      state.aiErrors +=
        1;


      state.lastError =
        String(
          err?.message ||
          err
        );


      logger.error(
        {

          account:
            state.id,

          phone,

          err:
            String(
              err?.message ||
              err
            )

        },

        'AI auto reply failed'
      );

    }


  } catch (err) {

    logger.error(
      {

        account:
          state.id,

        err:
          String(
            err?.stack ||
            err
          )

      },

      'Incoming message processing failed'
    );

  }

}


/* ============================================================
   STATUS
   ============================================================ */

function getStatus(
  state
) {

  const cfg =
    normalizeConfig(
      state.id
    );


  return {

    success:
      true,

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
      qrIsValid(
        state
      ),

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

    ai_replies:
      state.aiReplies,

    ai_errors:
      state.aiErrors,

    remembered_recipients:
      Object.keys(
        state.repliedUsers
      ).length,

    ai_only_numbers:
      cfg.ai_only_numbers,

    last_disconnect:
      state.lastDisconnect,

    error:
      state.lastError

  };

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

      success:
        true,

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

      success:
        false,

      error: {

        code,

        message,

        ...extra

      }

    });

}


function asyncRoute(
  fn
) {

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
    (
      resolve,
      reject
    ) => {

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


              reject(
                err
              );

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
    qrIsValid(
      state
    )
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
   CREATE SOCKET
   ============================================================ */

async function createSocket(
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


  if (
    state.connecting
  ) {

    await waitForCondition(

      () =>
        state.sock ||
        !state.connecting,

      15000

    ).catch(
      () => {}
    );


    if (
      state.sock
    ) {

      return state.sock;

    }

  }


  state.connecting =
    true;


  state.status =
    'connecting';


  state.lastError =
    null;


  state.generation +=
    1;


  const myGeneration =
    state.generation;


  const accountAuthDir =
    authPath(
      account
    );


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

          err:
            String(err)

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

      /*
       * WhatsApp account is marked online when connected.
       * We also explicitly call available on every incoming message.
       */

      markOnlineOnConnect:
        true,

      syncFullHistory:
        false,

      generateHighQualityLinkPreview:
        false,

      logger

    };


    if (
      version
    ) {

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
       INCOMING
       ======================================================== */

    sock.ev.on(
      'messages.upsert',
      async ({
        messages,
        type
      }) => {

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
       CONNECTION
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


        /* ====================================================
           QR
           ==================================================== */

        if (
          qr
        ) {

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

                  margin:
                    2,

                  width:
                    420

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


        /* ====================================================
           OPEN
           ==================================================== */

        if (
          connection ===
          'open'
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


          /*
           * Immediately mark online.
           */

          await markActive(
            state
          );


          logger.info(
            {

              account,

              jid:
                state.jid,

              phone:
                state.phone

            },

            'WhatsApp connected'
          );

        }


        /* ====================================================
           CLOSE
           ==================================================== */

        if (
          connection ===
          'close'
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

        err:
          String(err)

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

              err:
                String(err)

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
   GET SOCKET
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


  state.generation +=
    1;


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


  if (
    sock
  ) {

    try {

      sock.end(
        undefined
      );

    } catch (_) {}

  }

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


  try {

    await fs.promises.rm(
      authPath(account),
      {
        recursive:
          true,

        force:
          true
      }
    );


  } catch (err) {

    logger.warn(
      {

        account,

        err:
          String(err)

      },

      'Could not remove auth directory'
    );

  }


  try {

    await fs.promises.rm(
      autoReplyPath(account),
      {
        force:
          true
      }
    );


    await fs.promises.rm(
      historyPath(account),
      {
        force:
          true
      }
    );


    await fs.promises.rm(

      path.join(
        dataPath(account),
        'replied-users.json'
      ),

      {
        force:
          true
      }

    );


  } catch (_) {}


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

}


/* ============================================================
   ROOT
   ============================================================ */

app.get(
  '/',
  (req, res) => {

    res.json({

      success:
        true,

      name:
        'WhatsApp Multi-Account AI Connector',

      version:
        '3.0.0',

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

        auto_online_on_message:
          true,

        welcome_message:
          true,

        busy_message:
          true,

        ai_auto_reply:
          OPENAI_ENABLED,

        ai_new_users:
          AUTO_AI_NEW_USERS,

        ai_only_numbers:
          true,

        conversation_memory:
          true,

        multiple_openai_keys:
          AI_KEYS.length,

        broadcast:
          true,

        media:
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
          'POST /send-to-all',

        autoReplyConfig:
          'GET/POST /auto-reply/config',

        aiNumber:
          'POST /auto-reply/number'

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

      success:
        true,

      status:
        'online',

      uptime:
        process.uptime(),

      accounts:
        accounts.size,

      openai: {

        enabled:
          OPENAI_ENABLED,

        configured_keys:
          AI_KEYS.length,

        model:
          OPENAI_MODEL

      }

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
    async (
      req,
      res
    ) => {

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


      } catch (_) {

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
    async (
      req,
      res
    ) => {

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
              qrIsValid(state),

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
    async (
      req,
      res
    ) => {

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


        await sleep(
          1500
        );


        const code =
          await sock
            .requestPairingCode(
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
    async (
      req,
      res
    ) => {

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
    async (
      req,
      res
    ) => {

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
            'Authentication and AI conversation state reset. Connect again.'

        }
      );

    }
  )
);


/* ============================================================
   GET AUTO REPLY CONFIG
   ============================================================ */

app.get(
  '/auto-reply/config',
  (
    req,
    res
  ) => {

    const account =
      accountIdFromRequest(
        req
      );


    return ok(
      res,
      {

        account,

        config: {

          ...normalizeConfig(
            account
          ),

          openai: {

            enabled:
              OPENAI_ENABLED,

            configured_keys:
              AI_KEYS.length,

            model:
              OPENAI_MODEL

          }

        }

      }
    );

  }
);


/* ============================================================
   SET AUTO REPLY CONFIG
   ============================================================ */

app.post(
  '/auto-reply/config',
  (
    req,
    res
  ) => {

    const account =
      accountIdFromRequest(
        req
      );


    const current =
      normalizeConfig(
        account
      );


    const incoming =
      req.body || {};


    const allowed = [

      'enabled',

      'ai_enabled',

      'ai_new_users',

      'ai_only_numbers',

      'welcome_enabled',

      'welcome_text',

      'busy_enabled',

      'busy_text',

      'busy_mode',

      'ai_all_messages',

      'reply_to_media',

      'system_prompt',

      'max_history'

    ];


    const patch = {};


    for (
      const key of
      allowed
    ) {

      if (
        incoming[key] !==
        undefined
      ) {

        patch[key] =
          incoming[key];

      }

    }


    if (
      patch.busy_mode !==
      undefined
    ) {

      const mode =
        String(
          patch.busy_mode
        ).toLowerCase();


      if (
        ![
          'before_ai',
          'instead'
        ].includes(mode)
      ) {

        return fail(

          res,

          422,

          'INVALID_BUSY_MODE',

          'busy_mode must be before_ai or instead'

        );

      }


      patch.busy_mode =
        mode;

    }


    const saved =
      saveConfig(

        account,

        {

          ...current,

          ...patch

        }

      );


    return ok(
      res,
      {

        account,

        config: {

          ...saved,

          openai: {

            enabled:
              OPENAI_ENABLED,

            configured_keys:
              AI_KEYS.length,

            model:
              OPENAI_MODEL

          }

        },

        message:
          'Auto-reply configuration saved'

      }
    );

  }
);


/* ============================================================
   SET AI-ONLY NUMBER
   ============================================================ */

/*
 * POST /auto-reply/number
 *
 * {
 *   "account": "user1",
 *   "phone": "9876543210",
 *   "enabled": true
 * }
 *
 * enabled=true:
 *
 *     ONLY AI replies
 *
 *     Welcome skipped
 *     Busy skipped
 *
 * enabled=false:
 *
 *     Number removed from AI-only mode
 */

app.post(
  '/auto-reply/number',
  (
    req,
    res
  ) => {

    const account =
      accountIdFromRequest(
        req
      );


    let phone;


    try {

      phone =
        normalizePhone(

          req.body?.phone ||

          req.body?.number

        );

    } catch (err) {

      return fail(
        res,
        422,
        'INVALID_PHONE',
        err.message
      );

    }


    const cfg =
      normalizeConfig(
        account
      );


    const enabled =
      String(
        req.body?.enabled ??
        'true'
      ).toLowerCase() !==
      'false';


    const set =
      new Set(
        cfg.ai_only_numbers
      );


    if (
      enabled
    ) {

      set.add(
        phone
      );

    } else {

      set.delete(
        phone
      );

    }


    cfg.ai_only_numbers =
      [
        ...set
      ];


    const saved =
      saveConfig(
        account,
        cfg
      );


    return ok(
      res,
      {

        account,

        phone,

        ai_only:
          enabled,

        ai_only_numbers:
          saved.ai_only_numbers,

        message:

          enabled

            ? `${phone} is now AI-only`

            : `${phone} was removed from AI-only`

      }
    );

  }
);


/* ============================================================
   SEND MESSAGE
   ============================================================ */

app.post(
  '/send-message',
  asyncRoute(
    async (
      req,
      res
    ) => {

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
          await state.sock
            .sendMessage(
              jid,
              {
                text:
                  message
              }
            );


        state.outgoingMessages +=
          1;


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

app.post(
  '/send-to-all',
  asyncRoute(
    async (
      req,
      res
    ) => {

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


      if (
        !input &&
        req.body?.phone
      ) {

        input =
          [
            req.body.phone
          ];

      }


      if (
        typeof input ===
        'string'
      ) {

        input =
          input
            .split(',')
            .map(
              x =>
                x.trim()
            )
            .filter(Boolean);

      }


      if (
        !Array.isArray(input) ||
        !input.length
      ) {

        return fail(

          res,

          422,

          'RECIPIENTS_REQUIRED',

          'phones must be a non-empty array'

        );

      }


      const unique = [

        ...new Set(

          input

            .map(
              x => {

                try {

                  return normalizePhone(
                    x
                  );

                } catch (_) {

                  return null;

                }

              }
            )

            .filter(Boolean)

        )

      ];


      if (
        !unique.length
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


      const results =
        [];


      for (
        const phone of
        unique
      ) {

        try {

          const jid =
            jidForPhone(
              phone
            );


          const result =
            await state.sock
              .sendMessage(
                jid,
                {
                  text:
                    message
                }
              );


          state.outgoingMessages +=
            1;


          results.push({

            phone,

            success:
              true,

            jid,

            message_id:
              result?.key?.id ||
              null

          });


          await sleep(
            250
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
          x =>
            x.success
        ).length;


      return ok(
        res,
        {

          account,

          total:
            results.length,

          sent,

          failed:
            results.length -
            sent,

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
    async (
      req,
      res
    ) => {

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

          type ===
            'image' ||

          type ===
            'photo'

        ) {

          content = {

            image: {
              url:
                mediaUrl
            },

            caption

          };

        }

        else if (
          type === 'video'
        ) {

          content = {

            video: {
              url:
                mediaUrl
            },

            caption

          };

        }

        else if (
          type === 'audio'
        ) {

          content = {

            audio: {
              url:
                mediaUrl
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

          type ===
            'document' ||

          type ===
            'file'

        ) {

          content = {

            document: {
              url:
                mediaUrl
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
          await state.sock
            .sendMessage(
              jid,
              content
            );


        state.outgoingMessages +=
          1;


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
  (
    req,
    res
  ) => {

    res
      .status(404)
      .json({

        success:
          false,

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
  (
    err,
    req,
    res,
    next
  ) => {

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

      return next(
        err
      );

    }


    res
      .status(500)
      .json({

        success:
          false,

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
            AUTO_REPLY_DEFAULT_ENABLED,

          openAI:
            OPENAI_ENABLED,

          openAIKeys:
            AI_KEYS.length,

          openAIModel:
            OPENAI_MODEL

        },

        'WhatsApp AI connector started'
      );


      console.log(

        `WhatsApp AI connector listening on ${HOST}:${PORT}`

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
          withFileTypes:
            true
        }

      );


    for (
      const entry of
      entries
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
        !fs.existsSync(
          credsPath
        )
      ) {

        continue;

      }


      logger.info(
        {

          account

        },

        'Restoring saved WhatsApp account'
      );


      createSocket(
        account
      )
        .catch(
          err => {

            logger.error(
              {

                account,

                err:
                  String(err)

              },

              'Account restore failed'
            );

          }
        );

    }


  } catch (err) {

    logger.error(
      {

        err:
          String(err)

      },

      'Account restore scan failed'
    );

  }

}


restoreAccounts();


/* ============================================================
   SHUTDOWN
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
    ]
    of accounts.entries()
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

        state.generation +=
          1;


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

          err:
            String(err)

        },

        'Error while closing account'
      );

    }

  }


  server.close(
    () =>
      process.exit(0)
  );


  setTimeout(
    () =>
      process.exit(0),
    5000
  ).unref();

}


process.on(
  'SIGTERM',
  () =>
    shutdown(
      'SIGTERM'
    )
);


process.on(
  'SIGINT',
  () =>
    shutdown(
      'SIGINT'
    )
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
