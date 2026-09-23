/**
 * RB WhatsApp Connector
 * Version: 2.0.0
 *
 * Compatible with:
 * - RB PHP WhatsApp Management Panel
 * - Multiple WhatsApp accounts
 * - QR connection
 * - Pairing-code connection
 * - Text messages
 * - Media messages
 * - Opt-in bulk messaging
 * - Bulk job progress
 * - Account status
 *
 * Requirements:
 *   Node.js 20+
 *
 * Install:
 *   npm install
 *
 * Start:
 *   npm start
 *
 * Environment:
 *   PORT=3000
 *   API_TOKEN=your-secret-token
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import pino from "pino";
import QRCode from "qrcode";
import { fileURLToPath } from "url";
import { Boom } from "@hapi/boom";

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const API_TOKEN =
    process.env.API_TOKEN ||
    "CHANGE_THIS_CONNECTOR_TOKEN";

const DATA_DIR =
    process.env.DATA_DIR ||
    path.join(__dirname, "data");

const AUTH_DIR =
    process.env.AUTH_DIR ||
    path.join(DATA_DIR, "auth");

const ACCOUNTS_FILE =
    path.join(DATA_DIR, "accounts.json");

const JOBS_FILE =
    path.join(DATA_DIR, "jobs.json");

const LOG_FILE =
    path.join(DATA_DIR, "connector.log");

const DEFAULT_BULK_DELAY =
    Math.max(
        1000,
        Number(process.env.DEFAULT_BULK_DELAY || 2000)
    );

const MAX_BULK_RECIPIENTS =
    Math.min(
        500,
        Math.max(
            1,
            Number(process.env.MAX_BULK_RECIPIENTS || 100)
        )
    );

const QR_TTL =
    Number(process.env.QR_TTL || 120000);

const REQUEST_TIMEOUT =
    Number(process.env.REQUEST_TIMEOUT || 30000);

/* =========================================================
   DIRECTORIES
========================================================= */

fs.mkdirSync(DATA_DIR, {
    recursive: true
});

fs.mkdirSync(AUTH_DIR, {
    recursive: true
});

/* =========================================================
   LOGGER
========================================================= */

const logger = pino(
    {
        level: process.env.LOG_LEVEL || "info"
    },
    pino.destination(LOG_FILE)
);

const consoleLogger = pino({
    level: process.env.LOG_LEVEL || "info"
});

/* =========================================================
   EXPRESS
========================================================= */

const app = express();

app.disable("x-powered-by");

app.use(
    cors({
        origin: false,
        methods: [
            "GET",
            "POST",
            "DELETE",
            "OPTIONS"
        ],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "X-Connector-Token"
        ]
    })
);

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "10mb"
    })
);

/* =========================================================
   IN-MEMORY STATE
========================================================= */

const sockets = new Map();
const connecting = new Map();
const bulkRunning = new Map();

let accounts = loadJSON(
    ACCOUNTS_FILE,
    {}
);

let jobs = loadJSON(
    JOBS_FILE,
    {}
);

/* =========================================================
   HELPERS
========================================================= */

function now() {
    return new Date().toISOString();
}

function makeId(prefix = "id") {
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

    return String(value).trim();
}

function sleep(ms) {
    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}

function loadJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(
                file,
                JSON.stringify(
                    fallback,
                    null,
                    2
                )
            );

            return fallback;
        }

        const raw =
            fs.readFileSync(
                file,
                "utf8"
            );

        if (!raw.trim()) {
            return fallback;
        }

        return JSON.parse(raw);
    } catch (error) {
        consoleLogger.error(
            {
                error: error.message,
                file
            },
            "JSON load failed"
        );

        return fallback;
    }
}

function saveJSON(file, data) {
    const temp =
        file +
        "." +
        process.pid +
        ".tmp";

    fs.writeFileSync(
        temp,
        JSON.stringify(
            data,
            null,
            2
        )
    );

    fs.renameSync(
        temp,
        file
    );
}

function saveAccounts() {
    saveJSON(
        ACCOUNTS_FILE,
        accounts
    );
}

function saveJobs() {
    saveJSON(
        JOBS_FILE,
        jobs
    );
}

function logEvent(
    type,
    message,
    extra = {}
) {
    logger.info(
        {
            type,
            ...extra
        },
        message
    );

    consoleLogger.info(
        {
            type,
            ...extra
        },
        message
    );
}

function normalizePhone(phone) {
    return safeString(phone)
        .replace(/[^\d]/g, "");
}

function phoneToJid(phone) {
    const number =
        normalizePhone(phone);

    if (!number) {
        throw new Error(
            "Invalid phone number"
        );
    }

    return (
        number +
        "@s.whatsapp.net"
    );
}

function getAccount(id) {
    return accounts[id] || null;
}

function accountFolder(id) {
    return path.join(
        AUTH_DIR,
        id
    );
}

function ensureAccountShape(account) {
    return {
        id: account.id,
        name: account.name || account.id,

        phone:
            account.phone ||
            null,

        status:
            account.status ||
            "disconnected",

        connected:
            Boolean(
                account.connected
            ),

        qr:
            account.qr ||
            null,

        qr_image:
            account.qr_image ||
            null,

        qr_expires_at:
            account.qr_expires_at ||
            null,

        pairing_code:
            account.pairing_code ||
            null,

        connected_at:
            account.connected_at ||
            null,

        last_error:
            account.last_error ||
            null,

        created_at:
            account.created_at ||
            now(),

        updated_at:
            now()
    };
}

function publicAccount(account) {
    if (!account) {
        return null;
    }

    return {
        id: account.id,

        name:
            account.name ||
            account.id,

        phone:
            account.phone ||
            null,

        status:
            account.status ||
            "disconnected",

        connected:
            Boolean(
                account.connected
            ),

        qr_available:
            Boolean(
                account.qr
            ),

        qr_image:
            account.qr_image ||
            null,

        qr_expires_at:
            account.qr_expires_at ||
            null,

        pairing_code:
            account.pairing_code ||
            null,

        connected_at:
            account.connected_at ||
            null,

        last_error:
            account.last_error ||
            null,

        created_at:
            account.created_at ||
            null,

        updated_at:
            account.updated_at ||
            null
    };
}

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

function authenticate(req, res, next) {
    const token =
        safeString(
            req.headers[
                "x-connector-token"
            ]
        ) ||
        safeString(
            req.headers.authorization
        )
            .replace(/^Bearer\s+/i, "");

    if (!token) {
        return res.status(401).json({
            success: false,
            error: "Missing connector token"
        });
    }

    if (
        !crypto.timingSafeEqual(
            Buffer.from(token),
            Buffer.from(API_TOKEN)
        )
    ) {
        return res.status(401).json({
            success: false,
            error: "Invalid connector token"
        });
    }

    next();
}

/*
 * Safe timing-safe comparison.
 */
function tokenMatches(a, b) {
    const aa = Buffer.from(
        String(a || "")
    );

    const bb = Buffer.from(
        String(b || "")
    );

    if (aa.length !== bb.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        aa,
        bb
    );
}

/*
 * Replace authenticate with safe comparison.
 */
app.use((req, res, next) => {
    if (
        req.path === "/health"
    ) {
        return next();
    }

    const token =
        safeString(
            req.headers[
                "x-connector-token"
            ]
        ) ||
        safeString(
            req.headers.authorization
        )
            .replace(/^Bearer\s+/i, "");

    if (
        !tokenMatches(
            token,
            API_TOKEN
        )
    ) {
        return res.status(401).json({
            success: false,
            error: "Unauthorized"
        });
    }

    next();
});

/* =========================================================
   SOCKET HELPERS
========================================================= */

function getSocket(accountId) {
    return sockets.get(accountId) || null;
}

function updateAccount(
    accountId,
    patch
) {
    const account =
        accounts[accountId];

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

    saveAccounts();

    return account;
}

function clearQRCode(accountId) {
    updateAccount(
        accountId,
        {
            qr: null,
            qr_image: null,
            qr_expires_at: null
        }
    );
}

function clearPairingCode(accountId) {
    updateAccount(
        accountId,
        {
            pairing_code: null
        }
    );
}

/* =========================================================
   CONNECTION
========================================================= */

async function connectAccount(
    accountId
) {
    const account =
        getAccount(accountId);

    if (!account) {
        throw new Error(
            "Account not found"
        );
    }

    if (
        connecting.has(accountId)
    ) {
        return;
    }

    const existing =
        getSocket(accountId);

    if (existing) {
        try {
            if (
                existing.user &&
                existing.ws?.isOpen
            ) {
                updateAccount(
                    accountId,
                    {
                        status: "connected",
                        connected: true
                    }
                );

                return;
            }
        } catch (_) {}
    }

    connecting.set(
        accountId,
        true
    );

    updateAccount(
        accountId,
        {
            status: "connecting",
            connected: false,
            last_error: null
        }
    );

    try {
        const folder =
            accountFolder(
                accountId
            );

        fs.mkdirSync(
            folder,
            {
                recursive: true
            }
        );

        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                folder
            );

        let version;

        try {
            const latest =
                await fetchLatestBaileysVersion();

            version =
                latest.version;
        } catch (error) {
            consoleLogger.warn(
                {
                    error: error.message
                },
                "Could not fetch latest Baileys version"
            );
        }

        const socketConfig = {
            auth: {
                creds: state.creds,

                keys:
                    makeCacheableSignalKeyStore(
                        state.keys,
                        pino({
                            level: "silent"
                        })
                    )
            },

            logger: pino({
                level: "silent"
            }),

            markOnlineOnConnect:
                false,

            generateHighQualityLinkPreview:
                false,

            syncFullHistory:
                false
        };

        if (version) {
            socketConfig.version =
                version;
        }

        const sock =
            makeWASocket(
                socketConfig
            );

        sockets.set(
            accountId,
            sock
        );

        sock.ev.on(
            "creds.update",
            saveCreds
        );

        sock.ev.on(
            "connection.update",
            async update => {
                await handleConnectionUpdate(
                    accountId,
                    update
                );
            }
        );

        sock.ev.on(
            "messages.upsert",
            async data => {
                await handleMessages(
                    accountId,
                    data
                );
            }
        );

        sock.ev.on(
            "contacts.update",
            contacts => {
                logEvent(
                    "contacts",
                    "Contacts updated",
                    {
                        accountId,
                        count:
                            Array.isArray(
                                contacts
                            )
                                ? contacts.length
                                : 0
                    }
                );
            }
        );

        return sock;

    } catch (error) {
        sockets.delete(
            accountId
        );

        updateAccount(
            accountId,
            {
                status: "error",
                connected: false,
                last_error:
                    error.message
            }
        );

        throw error;

    } finally {
        connecting.delete(
            accountId
        );
    }
}

/* =========================================================
   CONNECTION UPDATE
========================================================= */

async function handleConnectionUpdate(
    accountId,
    update
) {
    const {
        connection,
        lastDisconnect,
        qr
    } = update;

    const account =
        getAccount(accountId);

    if (!account) {
        return;
    }

    if (qr) {
        try {
            const qrImage =
                await QRCode.toDataURL(
                    qr,
                    {
                        margin: 2,
                        width: 420
                    }
                );

            updateAccount(
                accountId,
                {
                    status: "qr",
                    connected: false,
                    qr,
                    qr_image:
                        qrImage,
                    qr_expires_at:
                        new Date(
                            Date.now() +
                            QR_TTL
                        ).toISOString(),
                    last_error: null
                }
            );

            logEvent(
                "qr",
                "QR generated",
                {
                    accountId
                }
            );

        } catch (error) {
            updateAccount(
                accountId,
                {
                    status: "error",
                    last_error:
                        error.message
                }
            );
        }
    }

    if (
        connection === "connecting"
    ) {
        updateAccount(
            accountId,
            {
                status: "connecting",
                connected: false
            }
        );
    }

    if (
        connection === "open"
    ) {
        const sock =
            getSocket(accountId);

        let phone =
            account.phone ||
            null;

        try {
            if (
                sock?.user?.id
            ) {
                phone =
                    normalizePhone(
                        sock.user.id.split(
                            ":"
                        )[0]
                    );
            }
        } catch (_) {}

        updateAccount(
            accountId,
            {
                phone,
                status: "connected",
                connected: true,
                connected_at:
                    now(),
                qr: null,
                qr_image: null,
                qr_expires_at: null,
                pairing_code: null,
                last_error: null
            }
        );

        logEvent(
            "connected",
            "WhatsApp account connected",
            {
                accountId,
                phone
            }
        );
    }

    if (
        connection === "close"
    ) {
        sockets.delete(
            accountId
        );

        const statusCode =
            lastDisconnect?.error
                ? (
                    lastDisconnect
                        .error
                        ?.output
                        ?.statusCode
                )
                : undefined;

        const loggedOut =
            statusCode ===
            DisconnectReason.loggedOut;

        const restartRequired =
            statusCode ===
            DisconnectReason.restartRequired;

        let errorMessage =
            "Connection closed";

        try {
            if (
                lastDisconnect?.error
            ) {
                errorMessage =
                    lastDisconnect
                        .error
                        .message ||
                    errorMessage;
            }
        } catch (_) {}

        if (loggedOut) {
            updateAccount(
                accountId,
                {
                    status: "logged_out",
                    connected: false,
                    last_error:
                        "WhatsApp session logged out"
                }
            );

            logEvent(
                "logout",
                "Account logged out",
                {
                    accountId
                }
            );

            return;
        }

        updateAccount(
            accountId,
            {
                status: "disconnected",
                connected: false,
                last_error:
                    errorMessage
            }
        );

        logEvent(
            "disconnected",
            "WhatsApp connection closed",
            {
                accountId,
                statusCode
            }
        );

        /*
         * Reconnect transient failures.
         */
        if (
            !loggedOut &&
            (
                restartRequired ||
                statusCode !==
                    DisconnectReason.loggedOut
            )
        ) {
            setTimeout(
                () => {
                    connectAccount(
                        accountId
                    ).catch(
                        error => {
                            updateAccount(
                                accountId,
                                {
                                    status:
                                        "error",
                                    connected:
                                        false,
                                    last_error:
                                        error.message
                                }
                            );
                        }
                    );
                },
                3000
            );
        }
    }
}

/* =========================================================
   MESSAGE EVENTS
========================================================= */

async function handleMessages(
    accountId,
    data
) {
    if (
        !data ||
        !Array.isArray(
            data.messages
        )
    ) {
        return;
    }

    for (
        const message of
        data.messages
    ) {
        try {
            if (
                !message ||
                !message.key
            ) {
                continue;
            }

            const remoteJid =
                message.key
                    .remoteJid;

            if (!remoteJid) {
                continue;
            }

            logEvent(
                "message",
                "WhatsApp message event",
                {
                    accountId,
                    remoteJid,
                    messageId:
                        message.key.id ||
                        null,
                    fromMe:
                        Boolean(
                            message.key
                                .fromMe
                        )
                }
            );

        } catch (error) {
            logger.error(
                {
                    error:
                        error.message,
                    accountId
                },
                "Message event failed"
            );
        }
    }
}

/* =========================================================
   CREATE ACCOUNT
========================================================= */

function createAccount(
    data
) {
    const requestedId =
        safeString(
            data.id
        );

    const id =
        requestedId ||
        makeId("wa");

    if (accounts[id]) {
        throw new Error(
            "Account ID already exists"
        );
    }

    const account =
        ensureAccountShape({
            id,

            name:
                safeString(
                    data.name
                ) ||
                id,

            phone:
                normalizePhone(
                    data.phone
                ) ||
                null,

            status:
                "disconnected",

            connected: false,

            qr: null,
            qr_image: null,
            qr_expires_at: null,
            pairing_code: null,
            connected_at: null,
            last_error: null,

            created_at: now(),
            updated_at: now()
        });

    accounts[id] =
        account;

    saveAccounts();

    return account;
}

/* =========================================================
   DELETE ACCOUNT
========================================================= */

async function deleteAccount(
    accountId,
    deleteSession = true
) {
    const account =
        getAccount(accountId);

    if (!account) {
        throw new Error(
            "Account not found"
        );
    }

    const sock =
        getSocket(accountId);

    if (sock) {
        try {
            sock.end(
                undefined
            );
        } catch (_) {}
    }

    sockets.delete(
        accountId
    );

    connecting.delete(
        accountId
    );

    delete accounts[
        accountId
    ];

    saveAccounts();

    if (
        deleteSession
    ) {
        const folder =
            accountFolder(
                accountId
            );

        try {
            fs.rmSync(
                folder,
                {
                    recursive: true,
                    force: true
                }
            );
        } catch (error) {
            logEvent(
                "delete_session_error",
                "Could not delete auth folder",
                {
                    accountId,
                    error:
                        error.message
                }
            );
        }
    }

    return true;
}

/* =========================================================
   SEND TEXT
========================================================= */

async function sendText(
    accountId,
    phone,
    message
) {
    const sock =
        getSocket(accountId);

    if (!sock) {
        throw new Error(
            "WhatsApp account is not connected"
        );
    }

    const account =
        getAccount(accountId);

    if (
        !account ||
        !account.connected
    ) {
        throw new Error(
            "WhatsApp account is not connected"
        );
    }

    const number =
        normalizePhone(phone);

    if (!number) {
        throw new Error(
            "Invalid recipient phone"
        );
    }

    const text =
        safeString(message);

    if (!text) {
        throw new Error(
            "Message is empty"
        );
    }

    const jid =
        phoneToJid(
            number
        );

    const result =
        await sock.sendMessage(
            jid,
            {
                text
            }
        );

    logEvent(
        "send_text",
        "Text message sent",
        {
            accountId,
            phone: number,
            messageId:
                result?.key?.id ||
                null
        }
    );

    return {
        success: true,
        message_id:
            result?.key?.id ||
            null,
        phone: number
    };
}

/* =========================================================
   MEDIA HELPERS
========================================================= */

function detectMime(
    mime,
    type
) {
    if (mime) {
        return mime;
    }

    switch (
        String(type || "")
            .toLowerCase()
    ) {
        case "image":
            return "image/jpeg";

        case "video":
            return "video/mp4";

        case "audio":
            return "audio/mpeg";

        case "document":
            return "application/octet-stream";

        default:
            return "application/octet-stream";
    }
}

async function fetchMedia(
    url
) {
    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () =>
                controller.abort(),
            REQUEST_TIMEOUT
        );

    try {
        const response =
            await fetch(
                url,
                {
                    signal:
                        controller.signal
                }
            );

        if (!response.ok) {
            throw new Error(
                `Media download failed: HTTP ${response.status}`
            );
        }

        const contentType =
            response.headers.get(
                "content-type"
            ) || "";

        const arrayBuffer =
            await response.arrayBuffer();

        return {
            buffer:
                Buffer.from(
                    arrayBuffer
                ),

            contentType
        };

    } finally {
        clearTimeout(
            timer
        );
    }
}

/* =========================================================
   SEND MEDIA
========================================================= */

async function sendMedia(
    accountId,
    phone,
    type,
    url,
    caption,
    filename,
    mime
) {
    const sock =
        getSocket(accountId);

    if (!sock) {
        throw new Error(
            "WhatsApp account is not connected"
        );
    }

    const account =
        getAccount(accountId);

    if (
        !account ||
        !account.connected
    ) {
        throw new Error(
            "WhatsApp account is not connected"
        );
    }

    const number =
        normalizePhone(phone);

    if (!number) {
        throw new Error(
            "Invalid recipient phone"
        );
    }

    if (!url) {
        throw new Error(
            "Media URL is required"
        );
    }

    const mediaType =
        String(type || "image")
            .toLowerCase();

    if (
        ![
            "image",
            "video",
            "audio",
            "document"
        ].includes(
            mediaType
        )
    ) {
        throw new Error(
            "Unsupported media type"
        );
    }

    const downloaded =
        await fetchMedia(
            url
        );

    const finalMime =
        detectMime(
            mime ||
                downloaded.contentType,
            mediaType
        );

    const jid =
        phoneToJid(
            number
        );

    let content;

    if (
        mediaType === "image"
    ) {
        content = {
            image:
                downloaded.buffer,
            mimetype:
                finalMime,
            caption:
                safeString(
                    caption
                ) || undefined
        };
    }

    if (
        mediaType === "video"
    ) {
        content = {
            video:
                downloaded.buffer,
            mimetype:
                finalMime,
            caption:
                safeString(
                    caption
                ) || undefined
        };
    }

    if (
        mediaType === "audio"
    ) {
        content = {
            audio:
                downloaded.buffer,
            mimetype:
                finalMime,
            ptt: false
        };
    }

    if (
        mediaType === "document"
    ) {
        content = {
            document:
                downloaded.buffer,
            mimetype:
                finalMime,
            fileName:
                safeString(
                    filename
                ) ||
                "document"
        };

        if (
            safeString(
                caption
            )
        ) {
            content.caption =
                safeString(
                    caption
                );
        }
    }

    const result =
        await sock.sendMessage(
            jid,
            content
        );

    logEvent(
        "send_media",
        "Media message sent",
        {
            accountId,
            phone: number,
            type: mediaType,
            messageId:
                result?.key?.id ||
                null
        }
    );

    return {
        success: true,
        message_id:
            result?.key?.id ||
            null,
        phone: number,
        type: mediaType
    };
}

/* =========================================================
   BULK HELPERS
========================================================= */

function normalizeRecipients(
    recipients
) {
    if (
        !Array.isArray(
            recipients
        )
    ) {
        return [];
    }

    const unique =
        new Set();

    for (
        const item of recipients
    ) {
        const phone =
            normalizePhone(
                typeof item ===
                    "object"
                    ? item.phone
                    : item
            );

        if (
            phone &&
            phone.length >= 8
        ) {
            unique.add(
                phone
            );
        }
    }

    return Array.from(
        unique
    );
}

function createBulkJob(
    data
) {
    const id =
        makeId("job");

    const recipients =
        normalizeRecipients(
            data.recipients
        );

    const job = {
        id,

        account_id:
            data.account_id,

        total:
            recipients.length,

        sent: 0,

        failed: 0,

        remaining:
            recipients.length,

        status: "queued",

        message:
            safeString(
                data.message
            ),

        delay:
            Math.max(
                1000,
                Number(
                    data.delay ||
                    DEFAULT_BULK_DELAY
                )
            ),

        recipients,

        results: [],

        created_at: now(),

        started_at: null,

        completed_at: null,

        error: null
    };

    jobs[id] = job;

    saveJobs();

    return job;
}

/* =========================================================
   BULK PROCESSOR
========================================================= */

async function processBulkJob(
    jobId
) {
    const job =
        jobs[jobId];

    if (!job) {
        return;
    }

    if (
        bulkRunning.has(
            jobId
        )
    ) {
        return;
    }

    bulkRunning.set(
        jobId,
        true
    );

    job.status =
        "running";

    job.started_at =
        now();

    saveJobs();

    try {
        for (
            let i = 0;
            i < job.recipients.length;
            i++
        ) {
            const phone =
                job.recipients[i];

            try {
                const result =
                    await sendText(
                        job.account_id,
                        phone,
                        job.message
                    );

                job.sent++;

                job.results.push({
                    phone,
                    success: true,
                    message_id:
                        result.message_id,
                    at: now()
                });

            } catch (error) {
                job.failed++;

                job.results.push({
                    phone,
                    success: false,
                    error:
                        error.message,
                    at: now()
                });
            }

            job.remaining =
                job.total -
                job.sent -
                job.failed;

            saveJobs();

            /*
             * Do not use ultra-fast sending.
             * Minimum 1000ms.
             */
            if (
                i <
                job.recipients.length -
                    1
            ) {
                await sleep(
                    Math.max(
                        1000,
                        job.delay
                    )
                );
            }
        }

        job.status =
            "completed";

        job.completed_at =
            now();

        job.remaining = 0;

        saveJobs();

        logEvent(
            "bulk_complete",
            "Bulk job completed",
            {
                jobId,
                accountId:
                    job.account_id,
                total:
                    job.total,
                sent:
                    job.sent,
                failed:
                    job.failed
            }
        );

    } catch (error) {
        job.status =
            "failed";

        job.error =
            error.message;

        job.completed_at =
            now();

        saveJobs();

        logEvent(
            "bulk_failed",
            "Bulk job failed",
            {
                jobId,
                error:
                    error.message
            }
        );

    } finally {
        bulkRunning.delete(
            jobId
        );
    }
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/health",
    (req, res) => {
        res.json({
            success: true,

            status: "ok",

            service:
                "RB WhatsApp Connector",

            version: "2.0.0",

            node:
                process.version,

            uptime:
                process.uptime(),

            accounts:
                Object.keys(
                    accounts
                ).length,

            connected:
                Object.values(
                    accounts
                ).filter(
                    a =>
                        a.connected
                ).length,

            time: now()
        });
    }
);

/* =========================================================
   ACCOUNT LIST
========================================================= */

app.get(
    "/api/accounts",
    (req, res) => {
        const list =
            Object.values(
                accounts
            ).map(
                publicAccount
            );

        res.json({
            success: true,
            accounts: list,
            total: list.length
        });
    }
);

/* =========================================================
   GET SINGLE ACCOUNT
========================================================= */

app.get(
    "/api/accounts/:id",
    (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Account not found"
                });
        }

        res.json({
            success: true,
            account:
                publicAccount(
                    account
                )
        });
    }
);

/* =========================================================
   CREATE ACCOUNT
========================================================= */

app.post(
    "/api/accounts",
    (req, res) => {
        try {
            const account =
                createAccount(
                    req.body || {}
                );

            res.json({
                success: true,
                account:
                    publicAccount(
                        account
                    )
            });

        } catch (error) {
            res.status(400)
                .json({
                    success: false,
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   ACCOUNT STATUS
========================================================= */

app.get(
    "/api/accounts/:id/status",
    (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Account not found"
                });
        }

        res.json({
            success: true,

            account:
                publicAccount(
                    account
                )
        });
    }
);

/* =========================================================
   CONNECT
========================================================= */

app.post(
    "/api/accounts/:id/connect",
    async (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Account not found"
                });
        }

        try {
            await connectAccount(
                account.id
            );

            res.json({
                success: true,
                account:
                    publicAccount(
                        getAccount(
                            account.id
                        )
                    )
            });

        } catch (error) {
            res.status(500)
                .json({
                    success: false,
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   QR
========================================================= */

app.get(
    "/api/accounts/:id/qr",
    async (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Account not found"
                });
        }

        /*
         * If socket isn't running,
         * start it.
         */
        if (
            !getSocket(
                account.id
            )
        ) {
            try {
                await connectAccount(
                    account.id
                );
            } catch (_) {}
        }

        res.json({
            success: true,

            account_id:
                account.id,

            qr:
                account.qr ||
                null,

            qr_image:
                account.qr_image ||
                null,

            qr_expires_at:
                account.qr_expires_at ||
                null,

            available:
                Boolean(
                    account.qr
                )
        });
    }
);

/* =========================================================
   PAIRING CODE
========================================================= */

app.post(
    "/api/accounts/:id/pair",
    async (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Account not found"
                });
        }

        const phone =
            normalizePhone(
                req.body?.phone
            );

        if (
            !phone ||
            phone.length < 8
        ) {
            return res.status(400)
                .json({
                    success: false,
                    error:
                        "Valid phone number is required"
                });
        }

        try {
            let sock =
                getSocket(
                    account.id
                );

            if (!sock) {
                await connectAccount(
                    account.id
                );

                await sleep(
                    1500
                );

                sock =
                    getSocket(
                        account.id
                    );
            }

            if (!sock) {
                throw new Error(
                    "Could not initialize WhatsApp socket"
                );
            }

            if (
                sock.authState &&
                sock.authState.creds &&
                sock.authState.creds
                    .registered
            ) {
                return res.status(400)
                    .json({
                        success: false,
                        error:
                            "Account is already registered"
                    });
            }

            /*
             * Baileys pairing code
             * requires digits only
             * with country code.
             */
            const code =
                await sock.requestPairingCode(
                    phone
                );

            updateAccount(
                account.id,
                {
                    phone,
                    pairing_code:
                        code,
                    status:
                        "pairing",
                    connected:
                        false,
                    qr: null,
                    qr_image: null,
                    qr_expires_at:
                        null
                }
            );

            res.json({
                success: true,

                account_id:
                    account.id,

                phone,

                pairing_code:
                    code
            });

        } catch (error) {
            updateAccount(
                account.id,
                {
                    status: "error",
                    last_error:
                        error.message
                }
            );

            res.status(500)
                .json({
                    success: false,
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   DISCONNECT
========================================================= */

app.post(
    "/api/accounts/:id/disconnect",
    async (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Account not found"
                });
        }

        const sock =
            getSocket(
                account.id
            );

        try {
            if (sock) {
                try {
                    sock.end(
                        undefined
                    );
                } catch (_) {}
            }

            sockets.delete(
                account.id
            );

            connecting.delete(
                account.id
            );

            updateAccount(
                account.id,
                {
                    status:
                        "disconnected",
                    connected:
                        false,
                    qr: null,
                    qr_image: null,
                    qr_expires_at:
                        null,
                    pairing_code:
                        null
                }
            );

            res.json({
                success: true,
                account:
                    publicAccount(
                        getAccount(
                            account.id
                        )
                    )
            });

        } catch (error) {
            res.status(500)
                .json({
                    success: false,
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   RESET SESSION
========================================================= */

app.post(
    "/api/accounts/:id/reset",
    async (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Account not found"
                });
        }

        try {
            const sock =
                getSocket(
                    account.id
                );

            if (sock) {
                try {
                    sock.logout();
                } catch (_) {}

                try {
                    sock.end(
                        undefined
                    );
                } catch (_) {}
            }

            sockets.delete(
                account.id
            );

            connecting.delete(
                account.id
            );

            const folder =
                accountFolder(
                    account.id
                );

            try {
                fs.rmSync(
                    folder,
                    {
                        recursive: true,
                        force: true
                    }
                );
            } catch (_) {}

            updateAccount(
                account.id,
                {
                    phone: null,
                    status:
                        "disconnected",
                    connected:
                        false,
                    qr: null,
                    qr_image: null,
                    qr_expires_at:
                        null,
                    pairing_code:
                        null,
                    connected_at:
                        null,
                    last_error:
                        null
                }
            );

            res.json({
                success: true,

                message:
                    "Account session reset",

                account:
                    publicAccount(
                        getAccount(
                            account.id
                        )
                    )
            });

        } catch (error) {
            res.status(500)
                .json({
                    success: false,
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   DELETE ACCOUNT
========================================================= */

app.delete(
    "/api/accounts/:id",
    async (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Account not found"
                });
        }

        try {
            await deleteAccount(
                account.id,
                true
            );

            res.json({
                success: true,
                message:
                    "Account deleted"
            });

        } catch (error) {
            res.status(500)
                .json({
                    success: false,
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   SEND MESSAGE
========================================================= */

app.post(
    "/api/send-message",
    async (req, res) => {
        const {
            account_id,
            phone,
            message
        } = req.body || {};

        if (!account_id) {
            return res.status(400)
                .json({
                    success: false,
                    error:
                        "account_id is required"
                });
        }

        try {
            const result =
                await sendText(
                    account_id,
                    phone,
                    message
                );

            res.json({
                success: true,

                account_id,

                phone:
                    result.phone,

                message_id:
                    result.message_id
            });

        } catch (error) {
            res.status(400)
                .json({
                    success: false,
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   SEND MEDIA
========================================================= */

app.post(
    "/api/send-media",
    async (req, res) => {
        const {
            account_id,
            phone,
            type,
            url,
            caption,
            filename,
            mime
        } = req.body || {};

        if (!account_id) {
            return res.status(400)
                .json({
                    success: false,
                    error:
                        "account_id is required"
                });
        }

        try {
            const result =
                await sendMedia(
                    account_id,
                    phone,
                    type,
                    url,
                    caption,
                    filename,
                    mime
                );

            res.json({
                success: true,

                account_id,

                phone:
                    result.phone,

                type:
                    result.type,

                message_id:
                    result.message_id
            });

        } catch (error) {
            res.status(400)
                .json({
                    success: false,
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   BULK SEND
========================================================= */

app.post(
    "/api/bulk",
    async (req, res) => {
        const {
            account_id,
            recipients,
            message,
            delay
        } = req.body || {};

        if (!account_id) {
            return res.status(400)
                .json({
                    success: false,
                    error:
                        "account_id is required"
                });
        }

        if (
            !Array.isArray(
                recipients
            )
        ) {
            return res.status(400)
                .json({
                    success: false,
                    error:
                        "recipients must be an array"
                });
        }

        const normalized =
            normalizeRecipients(
                recipients
            );

        if (
            !normalized.length
        ) {
            return res.status(400)
                .json({
                    success: false,
                    error:
                        "No valid recipients"
                });
        }

        if (
            normalized.length >
            MAX_BULK_RECIPIENTS
        ) {
            return res.status(400)
                .json({
                    success: false,

                    error:
                        `Maximum ${MAX_BULK_RECIPIENTS} recipients per job`
                });
        }

        if (
            !safeString(
                message
            )
        ) {
            return res.status(400)
                .json({
                    success: false,
                    error:
                        "Message is required"
                });
        }

        const account =
            getAccount(
                account_id
            );

        if (!account) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Account not found"
                });
        }

        if (
            !account.connected
        ) {
            return res.status(400)
                .json({
                    success: false,
                    error:
                        "Account is not connected"
                });
        }

        const job =
            createBulkJob({
                account_id,
                recipients:
                    normalized,
                message,
                delay:
                    Math.max(
                        1000,
                        Number(
                            delay ||
                            DEFAULT_BULK_DELAY
                        )
                    )
            });

        /*
         * Start asynchronously.
         */
        processBulkJob(
            job.id
        ).catch(
            error => {
                logger.error(
                    {
                        jobId:
                            job.id,
                        error:
                            error.message
                    },
                    "Bulk processor error"
                );
            }
        );

        res.json({
            success: true,

            job_id:
                job.id,

            status:
                job.status,

            total:
                job.total,

            sent:
                job.sent,

            failed:
                job.failed,

            remaining:
                job.remaining,

            delay:
                job.delay
        });
    }
);

/* =========================================================
   BULK STATUS
========================================================= */

app.get(
    "/api/bulk/:jobId",
    (req, res) => {
        const job =
            jobs[
                req.params.jobId
            ];

        if (!job) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Bulk job not found"
                });
        }

        res.json({
            success: true,

            job: {
                id: job.id,

                account_id:
                    job.account_id,

                status:
                    job.status,

                total:
                    job.total,

                sent:
                    job.sent,

                failed:
                    job.failed,

                remaining:
                    job.remaining,

                delay:
                    job.delay,

                created_at:
                    job.created_at,

                started_at:
                    job.started_at,

                completed_at:
                    job.completed_at,

                error:
                    job.error
            }
        });
    }
);

/* =========================================================
   BULK JOB LIST
========================================================= */

app.get(
    "/api/bulk",
    (req, res) => {
        const list =
            Object.values(
                jobs
            )
                .sort(
                    (a, b) =>
                        new Date(
                            b.created_at
                        ) -
                        new Date(
                            a.created_at
                        )
                )
                .slice(0, 100)
                .map(job => ({
                    id: job.id,

                    account_id:
                        job.account_id,

                    status:
                        job.status,

                    total:
                        job.total,

                    sent:
                        job.sent,

                    failed:
                        job.failed,

                    remaining:
                        job.remaining,

                    created_at:
                        job.created_at,

                    started_at:
                        job.started_at,

                    completed_at:
                        job.completed_at
                }));

        res.json({
            success: true,
            jobs: list
        });
    }
);

/* =========================================================
   DELETE OLD JOBS
========================================================= */

app.delete(
    "/api/bulk/:jobId",
    (req, res) => {
        const id =
            req.params.jobId;

        if (!jobs[id]) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Bulk job not found"
                });
        }

        if (
            bulkRunning.has(id)
        ) {
            return res.status(400)
                .json({
                    success: false,
                    error:
                        "Cannot delete a running job"
                });
        }

        delete jobs[id];

        saveJobs();

        res.json({
            success: true,
            message:
                "Bulk job deleted"
        });
    }
);

/* =========================================================
   RESET ALL JOBS
========================================================= */

app.delete(
    "/api/bulk",
    (req, res) => {
        for (
            const id of
            bulkRunning.keys()
        ) {
            return res.status(400)
                .json({
                    success: false,
                    error:
                        "Cannot clear jobs while a job is running"
                });
        }

        jobs = {};

        saveJobs();

        res.json({
            success: true,
            message:
                "Bulk jobs cleared"
        });
    }
);

/* =========================================================
   PING ACCOUNT
========================================================= */

app.get(
    "/api/accounts/:id/ping",
    async (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404)
                .json({
                    success: false,
                    error:
                        "Account not found"
                });
        }

        const sock =
            getSocket(
                account.id
            );

        res.json({
            success: true,

            account_id:
                account.id,

            socket:
                Boolean(sock),

            connected:
                Boolean(
                    account.connected
                ),

            phone:
                account.phone ||
                null,

            status:
                account.status
        });
    }
);

/* =========================================================
   CONNECT ALL SAVED ACCOUNTS
========================================================= */

async function autoConnectAccounts() {
    const list =
        Object.values(
            accounts
        );

    for (
        const account of list
    ) {
        try {
            consoleLogger.info(
                `Restoring account: ${account.id}`
            );

            await connectAccount(
                account.id
            );

            /*
             * Small gap between
             * restoring accounts.
             */
            await sleep(1200);

        } catch (error) {
            updateAccount(
                account.id,
                {
                    status: "error",
                    connected: false,
                    last_error:
                        error.message
                }
            );

            consoleLogger.error(
                {
                    accountId:
                        account.id,
                    error:
                        error.message
                },
                "Account restore failed"
            );
        }
    }
}

/* =========================================================
   CLEAN OLD QR DATA
========================================================= */

setInterval(
    () => {
        const current =
            Date.now();

        for (
            const account of
            Object.values(
                accounts
            )
        ) {
            if (
                account.qr_expires_at
            ) {
                const expires =
                    new Date(
                        account.qr_expires_at
                    ).getTime();

                if (
                    expires <= current
                ) {
                    clearQRCode(
                        account.id
                    );

                    if (
                        account.status ===
                        "qr"
                    ) {
                        updateAccount(
                            account.id,
                            {
                                status:
                                    "connecting"
                            }
                        );
                    }
                }
            }
        }
    },
    10000
);

/* =========================================================
   CLEAN OLD JOBS
========================================================= */

setInterval(
    () => {
        const cutoff =
            Date.now() -
            7 *
                24 *
                60 *
                60 *
                1000;

        let changed =
            false;

        for (
            const [
                id,
                job
            ] of Object.entries(
                jobs
            )
        ) {
            if (
                bulkRunning.has(
                    id
                )
            ) {
                continue;
            }

            const time =
                new Date(
                    job.created_at
                ).getTime();

            if (
                time < cutoff
            ) {
                delete jobs[id];
                changed = true;
            }
        }

        if (changed) {
            saveJobs();
        }
    },
    60 *
        60 *
        1000
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (err, req, res, next) => {
        logger.error(
            {
                error:
                    err?.message ||
                    String(err),
                path:
                    req.path
            },
            "Unhandled request error"
        );

        if (
            res.headersSent
        ) {
            return next(err);
        }

        res.status(500)
            .json({
                success: false,
                error:
                    "Internal server error"
            });
    }
);

/* =========================================================
   START SERVER
========================================================= */

const server =
    app.listen(
        PORT,
        "0.0.0.0",
        async () => {
            consoleLogger.info(
                "========================================"
            );

            consoleLogger.info(
                " RB WhatsApp Connector v2.0.0"
            );

            consoleLogger.info(
                ` Port: ${PORT}`
            );

            consoleLogger.info(
                ` Accounts: ${
                    Object.keys(
                        accounts
                    ).length
                }`
            );

            consoleLogger.info(
                ` Node: ${process.version}`
            );

            consoleLogger.info(
                "========================================"
            );

            await autoConnectAccounts();
        }
    );

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(
    signal
) {
    consoleLogger.info(
        `${signal} received. Shutting down...`
    );

    for (
        const [
            accountId,
            sock
        ] of sockets.entries()
    ) {
        try {
            sock.end(
                undefined
            );
        } catch (_) {}

        sockets.delete(
            accountId
        );
    }

    server.close(
        () => {
            process.exit(0);
        }
    );

    setTimeout(
        () => {
            process.exit(0);
        },
        5000
    );
}

process.on(
    "SIGTERM",
    () =>
        shutdown(
            "SIGTERM"
        )
);

process.on(
    "SIGINT",
    () =>
        shutdown(
            "SIGINT"
        )
);

process.on(
    "uncaughtException",
    error => {
        logger.fatal(
            {
                error:
                    error.message,
                stack:
                    error.stack
            },
            "Uncaught exception"
        );
    }
);

process.on(
    "unhandledRejection",
    reason => {
        logger.error(
            {
                error:
                    String(reason)
            },
            "Unhandled rejection"
        );
    }
);
