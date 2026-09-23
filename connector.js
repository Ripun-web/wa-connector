import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import QRCode from "qrcode";
import pino from "pino";
import { Boom } from "@hapi/boom";

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from "@whiskeysockets/baileys";

const app = express();

const PORT = Number(process.env.PORT || 3000);

const HOST = "0.0.0.0";

const APP_VERSION = "3.1.0";

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const QR_EXPIRE_MS = 5 * 60 * 1000; // 5 MINUTES

const CONNECT_TIMEOUT_MS = 60 * 1000;

const WATCHDOG_MS = 90 * 1000;

const RECONNECT_BASE_MS = 3000;

const RECONNECT_MAX_MS = 30000;

const MAX_RECONNECTS = 8;

const AUTH_DIR =
  process.env.AUTH_DIR ||
  path.join(process.cwd(), "auth_info_baileys");

const API_TOKEN =
  process.env.API_TOKEN ||
  "";

const WEBHOOK_URL =
  process.env.WEBHOOK_URL ||
  "";

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET ||
  "";

/*
|--------------------------------------------------------------------------
| EXPRESS
|--------------------------------------------------------------------------
*/

app.disable("x-powered-by");

app.use(
  express.json({
    limit: "25mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "25mb"
  })
);

/*
|--------------------------------------------------------------------------
| LOGGER
|--------------------------------------------------------------------------
*/

const logger = pino({
  level: process.env.LOG_LEVEL || "info"
});

/*
|--------------------------------------------------------------------------
| STATE
|--------------------------------------------------------------------------
*/

let sock = null;

let socketGeneration = 0;

let socketStarting = false;

let stopRequested = false;

let reconnectTimer = null;

let watchdogTimer = null;

let qrExpireTimer = null;

let qrValue = null;

let qrImage = null;

let qrExpiresAt = null;

let pairingCode = null;

let pairingPhone = null;

let pairingRequested = false;

let desiredMode = null;

let currentStatus = "disconnected";

let connected = false;

let connectedAt = null;

let connectedPhone = null;

let connectedName = null;

let lastError = null;

let reconnectCount = 0;

let lastDisconnectCode = null;

let lastDisconnectReason = null;

let startedAt = new Date().toISOString();

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function nowISO() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomId(prefix = "id") {
  return (
    prefix +
    "_" +
    crypto.randomBytes(8).toString("hex")
  );
}

function safeString(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value);
}

function normalizePhone(phone) {
  let value = safeString(phone);

  value = value
    .replace(/[^\d]/g, "")
    .replace(/^00/, "");

  /*
   * Pairing code requires country code.
   *
   * Example:
   * +91 98765 43210
   * ->
   * 919876543210
   */

  if (value.startsWith("91") && value.length === 12) {
    return value;
  }

  /*
   * Indian local 10-digit number.
   *
   * This connector assumes India if exactly 10 digits.
   */

  if (value.length === 10) {
    return "91" + value;
  }

  return value;
}

function maskPhone(phone) {
  const p = safeString(phone);

  if (p.length <= 4) {
    return p;
  }

  return (
    "*".repeat(Math.max(0, p.length - 4)) +
    p.slice(-4)
  );
}

function formatPairingCode(code) {
  if (!code) {
    return null;
  }

  const clean = String(code)
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();

  return clean.match(/.{1,4}/g)?.join("-") || clean;
}

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error.message) {
    return String(error.message);
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getDisconnectCode(error) {
  try {
    if (!error) {
      return null;
    }

    if (error instanceof Boom) {
      return error.output?.statusCode || null;
    }

    if (error.output?.statusCode) {
      return error.output.statusCode;
    }

    if (error.data?.statusCode) {
      return error.data.statusCode;
    }

    if (error.statusCode) {
      return error.statusCode;
    }

    return null;
  } catch {
    return null;
  }
}

function getDisconnectText(code) {
  const map = {
    401: "Logged out / unauthorized",
    403: "Forbidden",
    408: "Request timeout / QR expired",
    411: "Multidevice mismatch",
    428: "Connection closed",
    440: "Connection replaced",
    442: "Connection error",
    500: "Bad session",
    503: "Service unavailable",
    515: "Restart required",
    429: "Rate limited"
  };

  return map[code] || "Connection closed";
}

function isLoggedOut(code) {
  return code === DisconnectReason.loggedOut || code === 401;
}

function isRestartRequired(code) {
  return code === 515;
}

function isConnectionReplaced(code) {
  return code === 440;
}

function isRateLimited(code) {
  return code === 429;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function clearQrTimer() {
  if (qrExpireTimer) {
    clearTimeout(qrExpireTimer);
    qrExpireTimer = null;
  }
}

function clearTimers() {
  clearReconnectTimer();
  clearWatchdog();
  clearQrTimer();
}

function resetQRState() {
  qrValue = null;
  qrImage = null;
  qrExpiresAt = null;

  clearQrTimer();
}

function resetPairingState() {
  pairingCode = null;
  pairingPhone = null;
  pairingRequested = false;
}

function isCurrentSocket(generation) {
  return generation === socketGeneration;
}

/*
|--------------------------------------------------------------------------
| AUTH DIRECTORY
|--------------------------------------------------------------------------
*/

function ensureAuthDirectory() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, {
      recursive: true
    });
  }
}

function deleteAuthDirectory() {
  if (!fs.existsSync(AUTH_DIR)) {
    return;
  }

  fs.rmSync(AUTH_DIR, {
    recursive: true,
    force: true
  });
}

/*
|--------------------------------------------------------------------------
| WEBHOOK
|--------------------------------------------------------------------------
*/

async function sendWebhook(event, data = {}) {
  if (!WEBHOOK_URL) {
    return;
  }

  try {
    const payload = {
      id: randomId("evt"),
      event,
      timestamp: nowISO(),
      data
    };

    const headers = {
      "Content-Type": "application/json"
    };

    if (WEBHOOK_SECRET) {
      const signature = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(JSON.stringify(payload))
        .digest("hex");

      headers["x-webhook-signature"] = signature;
    }

    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
  } catch (error) {
    logger.warn(
      {
        error: getErrorMessage(error)
      },
      "Webhook failed"
    );
  }
}

/*
|--------------------------------------------------------------------------
| AUTHENTICATION
|--------------------------------------------------------------------------
*/

function checkApiToken(req, res, next) {
  if (!API_TOKEN) {
    return next();
  }

  const token =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

  if (token !== API_TOKEN) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  next();
}

app.use(checkApiToken);

/*
|--------------------------------------------------------------------------
| STATUS
|--------------------------------------------------------------------------
*/

function getStatusObject() {
  return {
    success: true,

    version: APP_VERSION,

    status: currentStatus,

    connected,

    phone: connectedPhone,

    name: connectedName,

    connected_at: connectedAt,

    started_at: startedAt,

    qr_available: Boolean(qrImage),

    qr_expires_at: qrExpiresAt,

    pairing_code: pairingCode,

    pairing_phone: pairingPhone
      ? maskPhone(pairingPhone)
      : null,

    pairing_requested: pairingRequested,

    desired_mode: desiredMode,

    reconnect_count: reconnectCount,

    last_disconnect_code: lastDisconnectCode,

    last_disconnect_reason: lastDisconnectReason,

    last_error: lastError
  };
}

/*
|--------------------------------------------------------------------------
| ROOT
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "WA Connector",
    version: APP_VERSION,
    status: currentStatus,
    connected,
    endpoints: {
      status: "GET /status",
      qr: "GET /qr",
      connect: "POST /connect",
      pair: "POST /pair",
      disconnect: "POST /disconnect",
      reset: "POST /reset",
      send_message: "POST /send-message",
      send_media: "POST /send-media"
    }
  });
});

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get("/health", (req, res) => {
  res.json({
    success: true,
    healthy: true,
    status: currentStatus,
    connected,
    uptime: process.uptime(),
    timestamp: nowISO()
  });
});

/*
|--------------------------------------------------------------------------
| STATUS ENDPOINT
|--------------------------------------------------------------------------
*/

app.get("/status", (req, res) => {
  res.json(getStatusObject());
});

/*
|--------------------------------------------------------------------------
| QR ENDPOINT
|--------------------------------------------------------------------------
*/

app.get("/qr", async (req, res) => {
  if (!qrValue) {
    return res.json({
      success: false,
      qr: null,
      qr_image: null,
      expires_at: null,
      error: "QR not available"
    });
  }

  if (
    qrExpiresAt &&
    Date.now() >= new Date(qrExpiresAt).getTime()
  ) {
    return res.json({
      success: false,
      qr: null,
      qr_image: null,
      expires_at: qrExpiresAt,
      error: "QR expired"
    });
  }

  /*
   * If image somehow wasn't generated,
   * generate it now.
   */

  if (!qrImage) {
    try {
      qrImage = await QRCode.toDataURL(qrValue, {
        width: 700,
        margin: 2,
        errorCorrectionLevel: "M"
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: getErrorMessage(error)
      });
    }
  }

  res.json({
    success: true,
    qr: qrValue,
    qr_image: qrImage,
    expires_at: qrExpiresAt
  });
});

/*
|--------------------------------------------------------------------------
| QR CREATION
|--------------------------------------------------------------------------
*/

async function setQRCode(qr, generation) {
  if (!isCurrentSocket(generation)) {
    return;
  }

  qrValue = qr;

  const expires = Date.now() + QR_EXPIRE_MS;

  qrExpiresAt = new Date(expires).toISOString();

  try {
    qrImage = await QRCode.toDataURL(qr, {
      width: 700,
      margin: 2,
      errorCorrectionLevel: "M"
    });
  } catch (error) {
    qrImage = null;

    lastError =
      "QR image generation failed: " +
      getErrorMessage(error);
  }

  currentStatus = desiredMode === "pairing"
    ? "pairing"
    : "qr";

  lastError = null;

  clearQrTimer();

  qrExpireTimer = setTimeout(async () => {
    if (!isCurrentSocket(generation)) {
      return;
    }

    if (connected) {
      return;
    }

    logger.info("QR expired after 5 minutes");

    lastError = "QR expired after 5 minutes";

    resetQRState();

    await restartSocket("qr-expired");
  }, QR_EXPIRE_MS);

  await sendWebhook("qr", {
    expires_at: qrExpiresAt
  });
}

/*
|--------------------------------------------------------------------------
| PAIRING CODE
|--------------------------------------------------------------------------
*/

async function requestPairCode(generation, phone) {
  if (!sock) {
    throw new Error("Socket not initialized");
  }

  if (!isCurrentSocket(generation)) {
    throw new Error("Socket is stale");
  }

  if (sock.authState?.creds?.registered) {
    throw new Error(
      "Session is already registered. Reset the session first."
    );
  }

  const normalized = normalizePhone(phone);

  if (!/^\d{10,15}$/.test(normalized)) {
    throw new Error(
      "Invalid phone number. Use full international number, e.g. 919876543210"
    );
  }

  pairingPhone = normalized;

  pairingRequested = true;

  /*
   * IMPORTANT:
   *
   * requestPairingCode must not be called immediately
   * after makeWASocket().
   *
   * We wait until connection update reaches connecting/open
   * or until a short timeout.
   */

  const started = Date.now();

  while (Date.now() - started < 20000) {
    if (!isCurrentSocket(generation)) {
      throw new Error("Socket changed while requesting pairing code");
    }

    if (!sock) {
      throw new Error("Socket disappeared");
    }

    /*
     * Baileys exposes websocket state internally.
     * Once websocket exists, pairing request can be sent.
     */

    if (
      sock.ws &&
      typeof sock.ws.send === "function"
    ) {
      break;
    }

    await sleep(250);
  }

  try {
    logger.info(
      {
        phone: maskPhone(normalized)
      },
      "Requesting WhatsApp pairing code"
    );

    const rawCode =
      await sock.requestPairingCode(normalized);

    pairingCode = formatPairingCode(rawCode);

    currentStatus = "pairing";

    lastError = null;

    logger.info(
      {
        code: pairingCode
      },
      "Pairing code generated"
    );

    await sendWebhook("pairing_code", {
      phone: maskPhone(normalized)
    });

    return pairingCode;
  } catch (error) {
    pairingRequested = false;

    pairingCode = null;

    const message = getErrorMessage(error);

    lastError = message;

    logger.error(
      {
        error: message
      },
      "Pairing code request failed"
    );

    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| SOCKET
|--------------------------------------------------------------------------
*/

async function createSocket(mode = "qr", phone = "") {
  if (socketStarting) {
    return;
  }

  socketStarting = true;

  stopRequested = false;

  desiredMode = mode;

  const generation = ++socketGeneration;

  clearTimers();

  resetQRState();

  if (mode !== "pairing") {
    resetPairingState();
  }

  currentStatus =
    mode === "pairing"
      ? "pairing"
      : "connecting";

  connected = false;

  connectedAt = null;

  connectedPhone = null;

  connectedName = null;

  lastError = null;

  ensureAuthDirectory();

  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(AUTH_DIR);

    /*
     * Fetch current WhatsApp Web version.
     */

    let version;

    try {
      const latest =
        await fetchLatestBaileysVersion();

      version = latest.version;

      logger.info(
        {
          version,
          isLatest: latest.isLatest
        },
        "WhatsApp Web version"
      );
    } catch (error) {
      logger.warn(
        {
          error: getErrorMessage(error)
        },
        "Could not fetch latest WhatsApp version"
      );

      version = undefined;
    }

    const browser = Browsers.ubuntu(
      "RB WhatsApp Connector"
    );

    const newSocket = makeWASocket({
      auth: state,

      ...(version ? { version } : {}),

      browser,

      logger: pino({
        level: process.env.BAILEYS_LOG_LEVEL || "silent"
      }),

      printQRInTerminal: false,

      markOnlineOnConnect: false,

      syncFullHistory: false,

      connectTimeoutMs: CONNECT_TIMEOUT_MS,

      defaultQueryTimeoutMs: 60 * 1000,

      keepAliveIntervalMs: 15000,

      generateHighQualityLinkPreview: false,

      shouldIgnoreJid: jid => {
        return jid === "status@broadcast";
      }
    });

    sock = newSocket;

    socketStarting = false;

    /*
     * Save credentials.
     */

    newSocket.ev.on(
      "creds.update",
      async () => {
        if (!isCurrentSocket(generation)) {
          return;
        }

        try {
          await saveCreds();
        } catch (error) {
          logger.error(
            {
              error: getErrorMessage(error)
            },
            "Failed saving credentials"
          );
        }
      }
    );

    /*
     * Connection updates.
     */

    newSocket.ev.on(
      "connection.update",
      async update => {
        if (!isCurrentSocket(generation)) {
          return;
        }

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        /*
         * QR
         */

        if (qr && !connected) {
          await setQRCode(
            qr,
            generation
          );

          /*
           * If pairing mode, we still allow QR internally.
           * It isn't shown as the main pairing UI.
           */

          if (
            mode === "pairing" &&
            !pairingCode &&
            !pairingRequested
          ) {
            try {
              await requestPairCode(
                generation,
                phone
              );
            } catch {
              /*
               * Error already stored in lastError.
               */
            }
          }
        }

        /*
         * Connecting
         */

        if (connection === "connecting") {
          currentStatus =
            mode === "pairing"
              ? "pairing"
              : "connecting";

          logger.info(
            {
              mode
            },
            "WhatsApp socket connecting"
          );

          clearWatchdog();

          watchdogTimer = setTimeout(
            async () => {
              if (!isCurrentSocket(generation)) {
                return;
              }

              if (connected) {
                return;
              }

              logger.warn(
                "Connection watchdog fired"
              );

              lastError =
                "Connection timed out";

              await restartSocket(
                "watchdog"
              );
            },
            WATCHDOG_MS
          );
        }

        /*
         * OPEN
         */

        if (connection === "open") {
          clearWatchdog();

          clearReconnectTimer();

          clearQrTimer();

          currentStatus = "connected";

          connected = true;

          connectedAt =
            connectedAt ||
            nowISO();

          reconnectCount = 0;

          lastError = null;

          resetQRState();

          /*
           * Get user identity.
           */

          try {
            const me =
              newSocket.user;

            if (me) {
              connectedPhone =
                me.id
                  ?.split(":")[0]
                  ?.split("@")[0] ||
                null;

              connectedName =
                me.name ||
                null;
            }
          } catch {}

          logger.info(
            {
              phone: connectedPhone,
              name: connectedName
            },
            "WhatsApp connected"
          );

          await sendWebhook(
            "connected",
            {
              phone: connectedPhone,
              name: connectedName,
              connected_at: connectedAt
            }
          );

          return;
        }

        /*
         * CLOSE
         */

        if (connection === "close") {
          clearWatchdog();

          if (!isCurrentSocket(generation)) {
            return;
          }

          connected = false;

          const error =
            lastDisconnect?.error;

          const code =
            getDisconnectCode(error);

          lastDisconnectCode = code;

          lastDisconnectReason =
            getDisconnectText(code);

          const errorText =
            getErrorMessage(error);

          logger.warn(
            {
              code,
              reason: lastDisconnectReason,
              error: errorText
            },
            "WhatsApp connection closed"
          );

          /*
           * Logged out.
           *
           * Don't automatically reconnect with the
           * invalid session.
           */

          if (isLoggedOut(code)) {
            currentStatus = "error";

            lastError =
              "WhatsApp session logged out. Reset and connect again.";

            connected = false;

            await sendWebhook(
              "logged_out",
              {
                code
              }
            );

            return;
          }

          /*
           * Connection replaced.
           */

          if (isConnectionReplaced(code)) {
            currentStatus = "error";

            lastError =
              "Connection was replaced by another WhatsApp Web session.";

            return;
          }

          /*
           * Rate limit.
           */

          if (isRateLimited(code)) {
            currentStatus = "error";

            lastError =
              "WhatsApp rate limited the connection. Please wait before reconnecting.";

            reconnectCount++;

            scheduleReconnect(
              generation,
              true
            );

            return;
          }

          /*
           * User requested disconnect.
           */

          if (stopRequested) {
            currentStatus =
              "disconnected";

            return;
          }

          /*
           * Restart required 515.
           */

          if (isRestartRequired(code)) {
            logger.info(
              "WhatsApp requested socket restart"
            );

            currentStatus =
              "connecting";

            await restartSocket(
              "restart-required"
            );

            return;
          }

          /*
           * Normal reconnect.
           */

          currentStatus = "error";

          lastError =
            errorText ||
            lastDisconnectReason;

          reconnectCount++;

          scheduleReconnect(
            generation,
            false
          );
        }
      }
    );

    /*
     * Incoming messages.
     */

    newSocket.ev.on(
      "messages.upsert",
      async event => {
        if (!isCurrentSocket(generation)) {
          return;
        }

        for (const message of event.messages || []) {
          try {
            const remoteJid =
              message?.key?.remoteJid;

            if (!remoteJid) {
              continue;
            }

            await sendWebhook(
              "message",
              {
                type: event.type,
                jid: remoteJid,
                message
              }
            );
          } catch (error) {
            logger.warn(
              {
                error: getErrorMessage(error)
              },
              "Message webhook failed"
            );
          }
        }
      }
    );

    /*
     * Message status updates.
     */

    newSocket.ev.on(
      "messages.update",
      async updates => {
        if (!isCurrentSocket(generation)) {
          return;
        }

        await sendWebhook(
          "messages_update",
          {
            updates
          }
        );
      }
    );

    /*
     * Groups / contacts etc can be handled by
     * PHP webhook if required.
     */

    /*
     * Pairing mode.
     *
     * Don't blindly wait 1.5 seconds.
     *
     * Wait until socket starts producing a QR/connection
     * update, then request pairing code.
     */

    if (
      mode === "pairing" &&
      !state.creds.registered
    ) {
      pairingPhone =
        normalizePhone(phone);

      /*
       * Small delay allows the websocket to initialize.
       * The actual readiness is still checked in
       * requestPairCode().
       */

      setTimeout(async () => {
        if (!isCurrentSocket(generation)) {
          return;
        }

        if (connected) {
          return;
        }

        if (pairingCode) {
          return;
        }

        try {
          await requestPairCode(
            generation,
            pairingPhone
          );
        } catch (error) {
          logger.error(
            {
              error: getErrorMessage(error)
            },
            "Initial pairing request failed"
          );
        }
      }, 1200);
    }

  } catch (error) {
    socketStarting = false;

    currentStatus = "error";

    lastError =
      getErrorMessage(error);

    logger.error(
      {
        error: lastError
      },
      "Socket creation failed"
    );

    if (!stopRequested) {
      reconnectCount++;

      scheduleReconnect(
        generation,
        false
      );
    }
  }
}

/*
|--------------------------------------------------------------------------
| RECONNECT
|--------------------------------------------------------------------------
*/

function scheduleReconnect(
  generation,
  rateLimited = false
) {
  if (stopRequested) {
    return;
  }

  if (!isCurrentSocket(generation)) {
    return;
  }

  clearReconnectTimer();

  if (reconnectCount > MAX_RECONNECTS) {
    currentStatus = "error";

    lastError =
      "Connection retry limit reached. Use /connect or /reset to start a fresh connection.";

    logger.error(
      "Reconnect retry limit reached"
    );

    return;
  }

  const multiplier =
    Math.max(
      0,
      reconnectCount - 1
    );

  let delay =
    RECONNECT_BASE_MS *
    Math.pow(2, multiplier);

  delay =
    Math.min(
      delay,
      RECONNECT_MAX_MS
    );

  if (rateLimited) {
    delay = Math.max(
      delay,
      60000
    );
  }

  logger.info(
    {
      delay,
      attempt: reconnectCount
    },
    "Scheduling reconnect"
  );

  reconnectTimer =
    setTimeout(async () => {
      reconnectTimer = null;

      if (stopRequested) {
        return;
      }

      await createSocket(
        desiredMode || "qr",
        pairingPhone || ""
      );
    }, delay);
}

/*
|--------------------------------------------------------------------------
| RESTART SOCKET
|--------------------------------------------------------------------------
*/

async function restartSocket(reason = "manual") {
  logger.info(
    {
      reason
    },
    "Restarting socket"
  );

  clearTimers();

  const oldSocket = sock;

  sock = null;

  connected = false;

  connectedAt = null;

  connectedPhone = null;

  connectedName = null;

  resetQRState();

  /*
   * Invalidate all old event handlers.
   */

  socketGeneration++;

  socketStarting = false;

  if (oldSocket) {
    try {
      oldSocket.end(
        new Error(
          "Socket restart: " + reason
        )
      );
    } catch {}
  }

  await sleep(400);

  if (stopRequested) {
    currentStatus =
      "disconnected";

    return;
  }

  await createSocket(
    desiredMode || "qr",
    pairingPhone || ""
  );
}

/*
|--------------------------------------------------------------------------
| CONNECT
|--------------------------------------------------------------------------
*/

app.post("/connect", async (req, res) => {
  try {
    stopRequested = false;

    clearTimers();

    if (connected) {
      return res.json({
        success: true,
        status: "connected",
        message: "Already connected"
      });
    }

    reconnectCount = 0;

    desiredMode = "qr";

    resetPairingState();

    if (sock) {
      try {
        sock.end(
          new Error("New connection requested")
        );
      } catch {}
    }

    sock = null;

    socketGeneration++;

    socketStarting = false;

    await createSocket("qr");

    res.json({
      success: true,
      status: "connecting",
      message: "QR connection started"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error)
    });
  }
});

/*
|--------------------------------------------------------------------------
| PAIR
|--------------------------------------------------------------------------
*/

app.post("/pair", async (req, res) => {
  try {
    let phone =
      req.body?.phone ||
      req.body?.number ||
      req.body?.phone_number;

    phone = normalizePhone(phone);

    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        error:
          "Invalid phone number. Example: 919876543210"
      });
    }

    /*
     * If already connected, don't create another socket.
     */

    if (connected) {
      return res.status(400).json({
        success: false,
        error:
          "Already connected. Disconnect/reset first."
      });
    }

    stopRequested = false;

    clearTimers();

    reconnectCount = 0;

    desiredMode = "pairing";

    pairingPhone = phone;

    pairingCode = null;

    pairingRequested = false;

    resetQRState();

    /*
     * Destroy old socket.
     */

    if (sock) {
      try {
        sock.end(
          new Error(
            "Starting new pairing session"
          )
        );
      } catch {}
    }

    sock = null;

    socketGeneration++;

    socketStarting = false;

    await createSocket(
      "pairing",
      phone
    );

    /*
     * Wait a little for pairing code.
     *
     * This is only API response waiting.
     * Socket remains alive after response.
     */

    const started =
      Date.now();

    while (
      Date.now() - started < 15000
    ) {
      if (pairingCode) {
        break;
      }

      if (
        currentStatus === "error" &&
        lastError
      ) {
        break;
      }

      await sleep(250);
    }

    if (!pairingCode) {
      return res.status(500).json({
        success: false,
        status: currentStatus,
        error:
          lastError ||
          "Pairing code could not be generated"
      });
    }

    res.json({
      success: true,
      status: "pairing",
      phone: maskPhone(phone),
      pairing_code: pairingCode
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error)
    });
  }
});

/*
|--------------------------------------------------------------------------
| DISCONNECT
|--------------------------------------------------------------------------
*/

app.post("/disconnect", async (req, res) => {
  try {
    stopRequested = true;

    clearTimers();

    socketGeneration++;

    const oldSocket = sock;

    sock = null;

    connected = false;

    connectedAt = null;

    connectedPhone = null;

    connectedName = null;

    resetQRState();

    resetPairingState();

    desiredMode = null;

    currentStatus =
      "disconnected";

    if (oldSocket) {
      try {
        oldSocket.end(
          new Error(
            "Disconnected by API"
          )
        );
      } catch {}
    }

    await sendWebhook(
      "disconnected",
      {}
    );

    res.json({
      success: true,
      status: "disconnected"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error)
    });
  }
});

/*
|--------------------------------------------------------------------------
| RESET
|--------------------------------------------------------------------------
*/

app.post("/reset", async (req, res) => {
  try {
    stopRequested = true;

    clearTimers();

    socketGeneration++;

    const oldSocket = sock;

    sock = null;

    connected = false;

    connectedAt = null;

    connectedPhone = null;

    connectedName = null;

    resetQRState();

    resetPairingState();

    desiredMode = null;

    currentStatus =
      "disconnected";

    if (oldSocket) {
      try {
        oldSocket.end(
          new Error(
            "Reset requested"
          )
        );
      } catch {}
    }

    await sleep(500);

    /*
     * Delete authentication.
     *
     * This forces WhatsApp to create a fresh
     * QR/pairing session.
     */

    deleteAuthDirectory();

    ensureAuthDirectory();

    reconnectCount = 0;

    lastError = null;

    currentStatus =
      "disconnected";

    res.json({
      success: true,
      status: "disconnected",
      message:
        "Session reset successfully. You can connect again."
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error)
    });
  }
});

/*
|--------------------------------------------------------------------------
| GET SOCKET
|--------------------------------------------------------------------------
*/

function requireSocket() {
  if (!sock) {
    throw new Error(
      "WhatsApp is not connected"
    );
  }

  if (!connected) {
    throw new Error(
      "WhatsApp is not connected yet"
    );
  }

  return sock;
}

/*
|--------------------------------------------------------------------------
| JID
|--------------------------------------------------------------------------
*/

function normalizeJid(number) {
  const value =
    safeString(number)
      .trim();

  if (value.includes("@")) {
    return value;
  }

  const phone =
    normalizePhone(value);

  if (!/^\d{10,15}$/.test(phone)) {
    throw new Error(
      "Invalid WhatsApp number"
    );
  }

  return phone + "@s.whatsapp.net";
}

/*
|--------------------------------------------------------------------------
| SEND MESSAGE
|--------------------------------------------------------------------------
*/

app.post(
  "/send-message",
  async (req, res) => {
    try {
      const wa =
        requireSocket();

      const number =
        req.body?.number ||
        req.body?.phone ||
        req.body?.to;

      const text =
        req.body?.message ||
        req.body?.text;

      if (!number) {
        return res.status(400).json({
          success: false,
          error: "Recipient number required"
        });
      }

      if (!text) {
        return res.status(400).json({
          success: false,
          error: "Message text required"
        });
      }

      const jid =
        normalizeJid(number);

      const result =
        await wa.sendMessage(
          jid,
          {
            text: String(text)
          }
        );

      res.json({
        success: true,
        message: result
      });

      await sendWebhook(
        "message_sent",
        {
          jid,
          message: text
        }
      );
    } catch (error) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error)
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| SEND MEDIA
|--------------------------------------------------------------------------
*/

app.post(
  "/send-media",
  async (req, res) => {
    try {
      const wa =
        requireSocket();

      const number =
        req.body?.number ||
        req.body?.phone ||
        req.body?.to;

      const mediaType =
        String(
          req.body?.type ||
          "image"
        ).toLowerCase();

      const caption =
        req.body?.caption ||
        "";

      const data =
        req.body?.data ||
        req.body?.base64;

      const url =
        req.body?.url;

      if (!number) {
        return res.status(400).json({
          success: false,
          error: "Recipient number required"
        });
      }

      const jid =
        normalizeJid(number);

      let mediaSource =
        data || url;

      if (!mediaSource) {
        return res.status(400).json({
          success: false,
          error:
            "Media data/base64 or URL required"
        });
      }

      /*
       * Convert data URL/base64 to Buffer.
       */

      let buffer;

      if (
        typeof mediaSource === "string" &&
        mediaSource.startsWith("data:")
      ) {
        const base64 =
          mediaSource.split(",")[1];

        buffer =
          Buffer.from(
            base64,
            "base64"
          );
      } else if (
        typeof mediaSource === "string" &&
        /^https?:\/\//i.test(mediaSource)
      ) {
        const response =
          await fetch(mediaSource);

        if (!response.ok) {
          throw new Error(
            `Media download failed: ${response.status}`
          );
        }

        const arrayBuffer =
          await response.arrayBuffer();

        buffer =
          Buffer.from(arrayBuffer);
      } else {
        buffer =
          Buffer.from(
            String(mediaSource),
            "base64"
          );
      }

      let message;

      if (
        mediaType === "image" ||
        mediaType === "photo"
      ) {
        message = {
          image: buffer,
          caption
        };
      }

      else if (
        mediaType === "video"
      ) {
        message = {
          video: buffer,
          caption
        };
      }

      else if (
        mediaType === "audio"
      ) {
        message = {
          audio: buffer,
          mimetype:
            req.body?.mimetype ||
            "audio/mp4",
          ptt:
            Boolean(
              req.body?.ptt
            )
        };
      }

      else if (
        mediaType === "document" ||
        mediaType === "file"
      ) {
        message = {
          document: buffer,
          mimetype:
            req.body?.mimetype ||
            "application/octet-stream",
          fileName:
            req.body?.fileName ||
            "document"
        };

        if (caption) {
          message.caption =
            caption;
        }
      }

      else {
        return res.status(400).json({
          success: false,
          error:
            "Unsupported media type"
        });
      }

      const result =
        await wa.sendMessage(
          jid,
          message
        );

      res.json({
        success: true,
        message: result
      });

      await sendWebhook(
        "media_sent",
        {
          jid,
          type: mediaType
        }
      );
    } catch (error) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error)
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error: "Endpoint not found"
    });
  }
);

/*
|--------------------------------------------------------------------------
| GLOBAL ERROR
|--------------------------------------------------------------------------
*/

app.use(
  (error, req, res, next) => {
    logger.error(
      {
        error: getErrorMessage(error)
      },
      "Express error"
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      success: false,
      error:
        getErrorMessage(error)
    });
  }
);

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

ensureAuthDirectory();

app.listen(
  PORT,
  HOST,
  () => {
    startedAt =
      nowISO();

    logger.info(
      `WA Connector ${APP_VERSION} running on ${HOST}:${PORT}`
    );

    logger.info(
      `QR expiry: 5 minutes`
    );

    logger.info(
      `Auth directory: ${AUTH_DIR}`
    );
  }
);

/*
|--------------------------------------------------------------------------
| GRACEFUL SHUTDOWN
|--------------------------------------------------------------------------
*/

async function shutdown(signal) {
  logger.info(
    `${signal} received. Shutting down...`
  );

  stopRequested = true;

  clearTimers();

  socketGeneration++;

  if (sock) {
    try {
      sock.end(
        new Error(
          "Server shutting down"
        )
      );
    } catch {}
  }

  sock = null;

  await sleep(300);

  process.exit(0);
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

/*
|--------------------------------------------------------------------------
| UNHANDLED ERRORS
|--------------------------------------------------------------------------
*/

process.on(
  "unhandledRejection",
  error => {
    logger.error(
      {
        error:
          getErrorMessage(error)
      },
      "Unhandled promise rejection"
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    logger.error(
      {
        error:
          getErrorMessage(error)
      },
      "Uncaught exception"
    );
  }
);
