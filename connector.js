import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import QRCode from "qrcode";
import P from "pino";
import { Boom } from "@hapi/boom";
import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers
} from "@whiskeysockets/baileys";
import {
  parsePhoneNumberFromString
} from "libphonenumber-js";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY || "IN";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const ROOT = process.cwd();
const SESSIONS_DIR = path.join(ROOT, "sessions");
const DATA_DIR = path.join(ROOT, "data");
const KEYS_FILE = path.join(DATA_DIR, "api-keys.json");

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(KEYS_FILE)) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify({}, null, 2));
}

const logger = P({ level: LOG_LEVEL });

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function now() {
  return new Date().toISOString();
}

function randomId(size = 8) {
  return crypto.randomBytes(size).toString("hex");
}

function safeUserId(id) {
  return String(id || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

function sessionPath(userId) {
  return path.join(SESSIONS_DIR, safeUserId(userId));
}

function readKeys() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeKeys(data) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
}

function hashKey(key) {
  return crypto
    .createHash("sha256")
    .update(key)
    .digest("hex");
}

function generateApiKey() {
  return `RBWA_live_${crypto.randomBytes(30).toString("base64url")}`;
}

function normalizePhone(phone) {
  if (!phone) return null;

  let value = String(phone)
    .trim()
    .replace(/[^\d+]/g, "");

  if (value.startsWith("00")) {
    value = "+" + value.substring(2);
  }

  if (!value.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(value, DEFAULT_COUNTRY);

    if (!parsed || !parsed.isValid()) {
      return null;
    }

    return parsed.number.replace("+", "");
  }

  const parsed = parsePhoneNumberFromString(value);

  if (!parsed || !parsed.isValid()) {
    return null;
  }

  return parsed.number.replace("+", "");
}

function jid(phone) {
  const normalized = normalizePhone(phone);

  if (!normalized) {
    throw new Error("Invalid phone number");
  }

  return `${normalized}@s.whatsapp.net`;
}

function jsonError(res, status, code, message, extra = {}) {
  return res.status(status).json({
    success: false,
    error: {
      code,
      message,
      ...extra
    }
  });
}

function jsonSuccess(res, data = {}) {
  return res.json({
    success: true,
    ...data
  });
}

/*
|--------------------------------------------------------------------------
| Account state
|--------------------------------------------------------------------------
*/

const accounts = new Map();

function createAccountState(userId) {
  return {
    id: userId,
    sock: null,
    connecting: false,
    connected: false,
    status: "disconnected",
    qr: null,
    qrDataUrl: null,
    qrCreatedAt: null,
    pairingCode: null,
    pairingCreatedAt: null,
    phone: null,
    lastError: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    reconnectTimer: null,
    generation: 0
  };
}

function getAccount(userId) {
  const id = safeUserId(userId);

  if (!id) {
    throw new Error("Invalid user ID");
  }

  if (!accounts.has(id)) {
    accounts.set(id, createAccountState(id));
  }

  return accounts.get(id);
}

/*
|--------------------------------------------------------------------------
| API key authentication
|--------------------------------------------------------------------------
*/

function findApiKey(rawKey) {
  if (!rawKey) return null;

  const keys = readKeys();
  const hash = hashKey(rawKey);

  for (const [id, item] of Object.entries(keys)) {
    if (
      item.hash === hash &&
      item.revoked !== true
    ) {
      return {
        id,
        ...item
      };
    }
  }

  return null;
}

function getBearerToken(req) {
  const auth = req.headers.authorization || "";

  if (auth.startsWith("Bearer ")) {
    return auth.substring(7).trim();
  }

  return req.headers["x-api-key"] || "";
}

function requireApiKey(req, res, next) {
  const token = getBearerToken(req);

  const item = findApiKey(token);

  if (!item) {
    return jsonError(
      res,
      401,
      "UNAUTHORIZED",
      "Missing or invalid API key"
    );
  }

  req.apiKey = item;

  next();
}

function requireAdmin(req, res, next) {
  const token = getBearerToken(req);

  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return jsonError(
      res,
      401,
      "ADMIN_UNAUTHORIZED",
      "Missing or invalid admin token"
    );
  }

  next();
}

/*
|--------------------------------------------------------------------------
| Account ownership
|--------------------------------------------------------------------------
*/

function requireAccount(req, res, next) {
  const requested =
    req.params.userId ||
    req.body.user_id ||
    req.body.user ||
    req.query.user_id;

  if (!requested) {
    return jsonError(
      res,
      400,
      "USER_ID_REQUIRED",
      "user_id is required"
    );
  }

  const userId = safeUserId(requested);

  if (!userId) {
    return jsonError(
      res,
      400,
      "INVALID_USER_ID",
      "Invalid user_id"
    );
  }

  if (req.apiKey && req.apiKey.user_id !== userId) {
    return jsonError(
      res,
      403,
      "ACCOUNT_FORBIDDEN",
      "API key does not have access to this account"
    );
  }

  req.userId = userId;
  req.account = getAccount(userId);

  next();
}

/*
|--------------------------------------------------------------------------
| Account status
|--------------------------------------------------------------------------
*/

function accountStatus(account) {
  return {
    user_id: account.id,
    status: account.status,
    connected: account.connected,
    phone: account.phone,
    has_qr: Boolean(account.qrDataUrl),
    qr_created_at: account.qrCreatedAt,
    pairing_code: account.pairingCode,
    pairing_created_at: account.pairingCreatedAt,
    last_connected_at: account.lastConnectedAt,
    last_disconnected_at: account.lastDisconnectedAt,
    last_error: account.lastError
  };
}

/*
|--------------------------------------------------------------------------
| Connect WhatsApp
|--------------------------------------------------------------------------
*/

async function connectAccount(userId, options = {}) {
  const account = getAccount(userId);

  if (account.connecting || account.connected) {
    return account;
  }

  account.connecting = true;
  account.status = "connecting";
  account.lastError = null;
  account.generation++;

  const generation = account.generation;

  const authDir = sessionPath(userId);

  fs.mkdirSync(authDir, {
    recursive: true
  });

  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(authDir);

    if (generation !== account.generation) {
      return account;
    }

    const sock = makeWASocket({
      auth: state,

      browser: Browsers.ubuntu("Chrome"),

      markOnlineOnConnect: false,

      syncFullHistory: false,

      connectTimeoutMs: 60000,

      keepAliveIntervalMs: 30000,

      logger
    });

    account.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async update => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (qr) {
        account.qr = qr;

        account.qrCreatedAt = Date.now();

        try {
          account.qrDataUrl =
            await QRCode.toDataURL(qr);
        } catch (error) {
          account.qrDataUrl = null;
          account.lastError = error.message;
        }

        account.status = "qr";
        account.connecting = true;
      }

      if (connection === "open") {
        account.connected = true;
        account.connecting = false;
        account.status = "connected";

        account.qr = null;
        account.qrDataUrl = null;
        account.qrCreatedAt = null;

        account.pairingCode = null;
        account.pairingCreatedAt = null;

        account.lastConnectedAt = now();

        try {
          account.phone =
            sock.user?.id?.split(":")[0] ||
            null;
        } catch {}
      }

      if (connection === "close") {
        account.connected = false;
        account.connecting = false;
        account.status = "disconnected";
        account.lastDisconnectedAt = now();

        const statusCode =
          new Boom(lastDisconnect?.error)?.output?.statusCode;

        const loggedOut =
          statusCode === DisconnectReason.loggedOut;

        const restartRequired =
          statusCode === DisconnectReason.restartRequired;

        account.sock = null;

        if (loggedOut) {
          account.status = "logged_out";
          return;
        }

        if (restartRequired) {
          setTimeout(() => {
            connectAccount(userId).catch(() => {});
          }, 1000);

          return;
        }

        setTimeout(() => {
          if (!account.connected) {
            connectAccount(userId).catch(error => {
              account.lastError = error.message;
            });
          }
        }, 3000);
      }
    });

    account.connecting = true;

    return account;

  } catch (error) {
    account.connecting = false;
    account.status = "error";
    account.lastError = error.message;

    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| Disconnect
|--------------------------------------------------------------------------
*/

async function disconnectAccount(userId, logout = false) {
  const account = getAccount(userId);

  account.generation++;

  if (account.reconnectTimer) {
    clearTimeout(account.reconnectTimer);
    account.reconnectTimer = null;
  }

  if (account.sock) {
    try {
      if (logout) {
        await account.sock.logout();
      } else {
        account.sock.end(undefined);
      }
    } catch {}
  }

  account.sock = null;
  account.connected = false;
  account.connecting = false;
  account.status = logout
    ? "logged_out"
    : "disconnected";
  account.qr = null;
  account.qrDataUrl = null;
  account.pairingCode = null;

  return account;
}

/*
|--------------------------------------------------------------------------
| Reset account
|--------------------------------------------------------------------------
*/

async function resetAccount(userId) {
  await disconnectAccount(userId, false);

  const dir = sessionPath(userId);

  if (fs.existsSync(dir)) {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }

  accounts.delete(userId);

  return getAccount(userId);
}

/*
|--------------------------------------------------------------------------
| Root / Health
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Multi WhatsApp API",
    version: "5.0.0",
    status: "online",
    accounts: accounts.size
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    uptime: process.uptime(),
    accounts: accounts.size
  });
});

/*
|--------------------------------------------------------------------------
| Account status
|--------------------------------------------------------------------------
*/

app.get(
  "/status/:userId",
  requireApiKey,
  requireAccount,
  (req, res) => {
    jsonSuccess(res, {
      account: accountStatus(req.account)
    });
  }
);

/*
|--------------------------------------------------------------------------
| QR
|--------------------------------------------------------------------------
*/

app.get(
  "/qr/:userId",
  requireApiKey,
  requireAccount,
  async (req, res) => {
    const account = req.account;

    if (!account.qrDataUrl) {
      return jsonError(
        res,
        404,
        "QR_NOT_AVAILABLE",
        "QR code is not currently available"
      );
    }

    const age =
      Date.now() - account.qrCreatedAt;

    if (age > 5 * 60 * 1000) {
      account.qr = null;
      account.qrDataUrl = null;

      return jsonError(
        res,
        410,
        "QR_EXPIRED",
        "QR code has expired"
      );
    }

    jsonSuccess(res, {
      user_id: account.id,
      qr: account.qrDataUrl,
      expires_in:
        Math.max(
          0,
          Math.floor(
            (5 * 60 * 1000 - age) / 1000
          )
        )
    });
  }
);

/*
|--------------------------------------------------------------------------
| Connect
|--------------------------------------------------------------------------
*/

app.post(
  "/connect/:userId",
  requireApiKey,
  requireAccount,
  async (req, res) => {
    try {
      await connectAccount(req.userId);

      jsonSuccess(res, {
        account: accountStatus(req.account)
      });
    } catch (error) {
      jsonError(
        res,
        500,
        "CONNECT_FAILED",
        error.message
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| Pairing code
|--------------------------------------------------------------------------
*/

app.post(
  "/pair/:userId",
  requireApiKey,
  requireAccount,
  async (req, res) => {
    const account = req.account;

    const phone =
      normalizePhone(
        req.body.phone ||
        req.body.number ||
        req.body.phone_number
      );

    if (!phone) {
      return jsonError(
        res,
        400,
        "INVALID_PHONE",
        "Valid phone number is required"
      );
    }

    try {
      if (!account.sock || !account.connecting) {
        await connectAccount(req.userId);
      }

      if (!account.sock) {
        return jsonError(
          res,
          503,
          "SOCKET_NOT_READY",
          "WhatsApp socket is not ready"
        );
      }

      const code =
        await account.sock.requestPairingCode(phone);

      account.pairingCode = code;
      account.pairingCreatedAt = now();

      jsonSuccess(res, {
        user_id: req.userId,
        phone,
        pairing_code: code
      });

    } catch (error) {
      jsonError(
        res,
        500,
        "PAIRING_FAILED",
        error.message
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| Disconnect
|--------------------------------------------------------------------------
*/

app.post(
  "/disconnect/:userId",
  requireApiKey,
  requireAccount,
  async (req, res) => {
    await disconnectAccount(
      req.userId,
      false
    );

    jsonSuccess(res, {
      account: accountStatus(req.account)
    });
  }
);

/*
|--------------------------------------------------------------------------
| Logout
|--------------------------------------------------------------------------
*/

app.post(
  "/logout/:userId",
  requireApiKey,
  requireAccount,
  async (req, res) => {
    await disconnectAccount(
      req.userId,
      true
    );

    jsonSuccess(res, {
      account: accountStatus(req.account)
    });
  }
);

/*
|--------------------------------------------------------------------------
| Reset
|--------------------------------------------------------------------------
*/

app.post(
  "/reset/:userId",
  requireApiKey,
  requireAccount,
  async (req, res) => {
    await resetAccount(req.userId);

    jsonSuccess(res, {
      user_id: req.userId,
      status: "reset"
    });
  }
);

/*
|--------------------------------------------------------------------------
| Send text message
|--------------------------------------------------------------------------
*/

app.post(
  "/send-message/:userId",
  requireApiKey,
  requireAccount,
  async (req, res) => {
    const account = req.account;

    if (!account.sock || !account.connected) {
      return jsonError(
        res,
        409,
        "NOT_CONNECTED",
        "WhatsApp account is not connected"
      );
    }

    const phone =
      normalizePhone(
        req.body.phone ||
        req.body.number ||
        req.body.to
      );

    const message =
      req.body.message ??
      req.body.text;

    if (!phone) {
      return jsonError(
        res,
        400,
        "INVALID_PHONE",
        "Valid phone number is required"
      );
    }

    if (
      typeof message !== "string" ||
      !message.trim()
    ) {
      return jsonError(
        res,
        400,
        "MESSAGE_REQUIRED",
        "Message is required"
      );
    }

    try {
      const result =
        await account.sock.sendMessage(
          jid(phone),
          {
            text: message
          }
        );

      jsonSuccess(res, {
        user_id: req.userId,
        message_id: result?.key?.id || null,
        phone,
        status: "sent"
      });

    } catch (error) {
      jsonError(
        res,
        500,
        "SEND_FAILED",
        error.message
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| Send media
|--------------------------------------------------------------------------
*/

app.post(
  "/send-media/:userId",
  requireApiKey,
  requireAccount,
  async (req, res) => {
    const account = req.account;

    if (!account.sock || !account.connected) {
      return jsonError(
        res,
        409,
        "NOT_CONNECTED",
        "WhatsApp account is not connected"
      );
    }

    const phone =
      normalizePhone(
        req.body.phone ||
        req.body.number ||
        req.body.to
      );

    const url =
      req.body.url ||
      req.body.media ||
      req.body.file;

    const type =
      String(req.body.type || "image")
        .toLowerCase();

    const caption =
      req.body.caption || "";

    if (!phone) {
      return jsonError(
        res,
        400,
        "INVALID_PHONE",
        "Valid phone number is required"
      );
    }

    if (!url) {
      return jsonError(
        res,
        400,
        "MEDIA_REQUIRED",
        "Media URL is required"
      );
    }

    let message;

    if (type === "image") {
      message = {
        image: {
          url
        },
        caption
      };
    } else if (type === "video") {
      message = {
        video: {
          url
        },
        caption
      };
    } else if (type === "document") {
      message = {
        document: {
          url
        },
        caption,
        fileName:
          req.body.fileName ||
          req.body.filename ||
          "document"
      };
    } else {
      return jsonError(
        res,
        400,
        "INVALID_MEDIA_TYPE",
        "Supported types: image, video, document"
      );
    }

    try {
      const result =
        await account.sock.sendMessage(
          jid(phone),
          message
        );

      jsonSuccess(res, {
        user_id: req.userId,
        message_id: result?.key?.id || null,
        phone,
        type,
        status: "sent"
      });

    } catch (error) {
      jsonError(
        res,
        500,
        "MEDIA_SEND_FAILED",
        error.message
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| ADMIN - API KEY CREATE
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/keys",
  requireAdmin,
  (req, res) => {
    const userId =
      safeUserId(
        req.body.user_id ||
        req.body.user
      );

    if (!userId) {
      return jsonError(
        res,
        400,
        "USER_ID_REQUIRED",
        "user_id is required"
      );
    }

    const keys = readKeys();

    const apiKey =
      generateApiKey();

    const id =
      `key_${randomId(6)}`;

    keys[id] = {
      id,
      user_id: userId,
      hash: hashKey(apiKey),
      created_at: now(),
      revoked: false
    };

    writeKeys(keys);

    /*
     * The plaintext key is returned only now.
     * It is never stored in plaintext.
     */

    jsonSuccess(res, {
      id,
      user_id: userId,
      api_key: apiKey
    });
  }
);

/*
|--------------------------------------------------------------------------
| ADMIN - LIST KEYS
|--------------------------------------------------------------------------
*/

app.get(
  "/admin/keys",
  requireAdmin,
  (req, res) => {
    const keys = readKeys();

    const result =
      Object.values(keys)
        .map(item => ({
          id: item.id,
          user_id: item.user_id,
          created_at: item.created_at,
          revoked: item.revoked
        }));

    jsonSuccess(res, {
      keys: result
    });
  }
);

/*
|--------------------------------------------------------------------------
| ADMIN - REVOKE KEY
|--------------------------------------------------------------------------
*/

app.delete(
  "/admin/keys/:keyId",
  requireAdmin,
  (req, res) => {
    const keys = readKeys();

    const item =
      keys[req.params.keyId];

    if (!item) {
      return jsonError(
        res,
        404,
        "KEY_NOT_FOUND",
        "API key not found"
      );
    }

    item.revoked = true;
    item.revoked_at = now();

    writeKeys(keys);

    jsonSuccess(res, {
      id: item.id,
      revoked: true
    });
  }
);

/*
|--------------------------------------------------------------------------
| ADMIN - LIST ACCOUNTS
|--------------------------------------------------------------------------
*/

app.get(
  "/admin/accounts",
  requireAdmin,
  (req, res) => {
    const result =
      [...accounts.values()]
        .map(accountStatus);

    jsonSuccess(res, {
      accounts: result
    });
  }
);

/*
|--------------------------------------------------------------------------
| ADMIN - CREATE/INITIALIZE ACCOUNT
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/accounts/:userId",
  requireAdmin,
  (req, res) => {
    const userId =
      safeUserId(req.params.userId);

    if (!userId) {
      return jsonError(
        res,
        400,
        "INVALID_USER_ID",
        "Invalid user ID"
      );
    }

    const account =
      getAccount(userId);

    jsonSuccess(res, {
      account: accountStatus(account)
    });
  }
);

/*
|--------------------------------------------------------------------------
| ADMIN - DELETE ACCOUNT
|--------------------------------------------------------------------------
*/

app.delete(
  "/admin/accounts/:userId",
  requireAdmin,
  async (req, res) => {
    const userId =
      safeUserId(req.params.userId);

    if (!userId) {
      return jsonError(
        res,
        400,
        "INVALID_USER_ID",
        "Invalid user ID"
      );
    }

    await resetAccount(userId);

    jsonSuccess(res, {
      user_id: userId,
      deleted: true
    });
  }
);

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  jsonError(
    res,
    404,
    "ENDPOINT_NOT_FOUND",
    "Endpoint not found"
  );
});

/*
|--------------------------------------------------------------------------
| Error handler
|--------------------------------------------------------------------------
*/

app.use((err, req, res, next) => {
  logger.error(err);

  if (res.headersSent) {
    return next(err);
  }

  jsonError(
    res,
    500,
    "INTERNAL_ERROR",
    "Internal server error"
  );
});

/*
|--------------------------------------------------------------------------
| Restore existing accounts
|--------------------------------------------------------------------------
*/

async function restoreAccounts() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    return;
  }

  const entries =
    fs.readdirSync(SESSIONS_DIR, {
      withFileTypes: true
    });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const userId =
      safeUserId(entry.name);

    if (!userId) {
      continue;
    }

    try {
      const account =
        getAccount(userId);

      /*
       * Only restore if credentials exist.
       */
      const credsFile =
        path.join(
          sessionPath(userId),
          "creds.json"
        );

      if (fs.existsSync(credsFile)) {
        connectAccount(userId)
          .catch(error => {
            account.lastError =
              error.message;
          });
      }
    } catch (error) {
      logger.error({
        userId,
        error
      });
    }
  }
}

/*
|--------------------------------------------------------------------------
| Server
|--------------------------------------------------------------------------
*/

app.listen(PORT, "0.0.0.0", async () => {
  console.log(
    `Multi WhatsApp API running on port ${PORT}`
  );

  await restoreAccounts();
});

/*
|--------------------------------------------------------------------------
| Shutdown
|--------------------------------------------------------------------------
*/

async function shutdown(signal) {
  console.log(
    `${signal}: shutting down`
  );

  for (const account of accounts.values()) {
    try {
      account.generation++;

      if (account.sock) {
        account.sock.end(undefined);
      }
    } catch {}
  }

  process.exit(0);
}

process.on("SIGTERM", () =>
  shutdown("SIGTERM")
);

process.on("SIGINT", () =>
  shutdown("SIGINT")
);

process.on(
  "unhandledRejection",
  error => {
    logger.error({
      unhandledRejection: error
    });
  }
);

process.on(
  "uncaughtException",
  error => {
    logger.error({
      uncaughtException: error
    });
  }
);
