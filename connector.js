'use strict';

/*
 * RB WhatsApp Connector
 * Multi-account Baileys connector
 *
 * Node.js: 20+
 *
 * Install:
 *   npm install
 *
 * Start:
 *   node connector.js
 *
 * Environment:
 *   PORT=3000
 *   API_TOKEN=your-secret-token
 *   DATA_DIR=./data
 *   SESSION_DIR=./auth
 *
 * Main API:
 *   GET    /health
 *   GET    /api/accounts
 *   POST   /api/accounts
 *   GET    /api/accounts/:id
 *   GET    /api/accounts/:id/status
 *   POST   /api/accounts/:id/connect
 *   GET    /api/accounts/:id/qr
 *   POST   /api/accounts/:id/pair
 *   POST   /api/accounts/:id/disconnect
 *   POST   /api/accounts/:id/reset
 *   DELETE /api/accounts/:id
 *
 * Sending:
 *   POST /api/send-message
 *   POST /api/send-media
 *
 * Bulk:
 *   POST /api/bulk
 *   GET  /api/bulk/:jobId
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const P = require('pino');
const QRCode = require('qrcode');

const app = express();

const PORT = Number(process.env.PORT || 3000);

const API_TOKEN = String(
    process.env.API_TOKEN ||
    process.env.CONNECTOR_TOKEN ||
    'change-this-token'
);

const DATA_DIR = path.resolve(
    process.env.DATA_DIR || path.join(__dirname, 'data')
);

const SESSION_DIR = path.resolve(
    process.env.SESSION_DIR || path.join(__dirname, 'auth')
);

const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

const MIN_BULK_DELAY = 1000;
const DEFAULT_BULK_DELAY = 2000;
const MAX_BULK_RECIPIENTS = 500;

const logger = P({
    level: process.env.LOG_LEVEL || 'info'
});

app.disable('x-powered-by');

app.use(express.json({
    limit: '2mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '2mb'
}));

/* =========================================================
   DIRECTORIES
========================================================= */

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {
            recursive: true
        });
    }
}

ensureDir(DATA_DIR);
ensureDir(SESSION_DIR);

/* =========================================================
   JSON DATABASE
========================================================= */

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }

        const raw = fs.readFileSync(file, 'utf8');

        if (!raw.trim()) {
            return fallback;
        }

        return JSON.parse(raw);
    } catch (error) {
        logger.error({
            file,
            error: error.message
        }, 'JSON read failed');

        return fallback;
    }
}

function writeJson(file, data) {
    const tmp = `${file}.tmp`;

    fs.writeFileSync(
        tmp,
        JSON.stringify(data, null, 2),
        'utf8'
    );

    fs.renameSync(tmp, file);
}

function loadAccounts() {
    const data = readJson(ACCOUNTS_FILE, []);

    return Array.isArray(data)
        ? data
        : [];
}

function saveAccounts(accounts) {
    writeJson(ACCOUNTS_FILE, accounts);
}

function loadJobs() {
    const data = readJson(JOBS_FILE, []);

    return Array.isArray(data)
        ? data
        : [];
}

function saveJobs(jobs) {
    /*
     * Keep the job history reasonably small.
     */
    const trimmed = jobs.slice(-1000);

    writeJson(JOBS_FILE, trimmed);
}

/* =========================================================
   MEMORY
========================================================= */

const sessions = new Map();

const bulkJobs = new Map();

let shuttingDown = false;

/* =========================================================
   HELPERS
========================================================= */

function now() {
    return new Date().toISOString();
}

function makeId(prefix = 'wa') {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanString(value, max = 10000) {
    return String(value ?? '')
        .trim()
        .slice(0, max);
}

function normalizePhone(phone) {
    let value = String(phone || '');

    value = value.replace(/[^\d]/g, '');

    /*
     * Remove leading 00.
     */
    if (value.startsWith('00')) {
        value = value.substring(2);
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

function displayPhone(phone) {
    const normalized = normalizePhone(phone);

    if (!normalized) {
        return 'Number not available';
    }

    if (normalized.length === 12 && normalized.startsWith('91')) {
        return `+${normalized}`;
    }

    return `+${normalized}`;
}

function safeError(error) {
    if (!error) {
        return 'Unknown error';
    }

    return String(
        error.message ||
        error.data ||
        error
    ).slice(0, 1000);
}

/* =========================================================
   AUTH
========================================================= */

function requireApiToken(req, res, next) {
    const headerToken = String(
        req.get('X-Connector-Token') ||
        req.get('X-API-Key') ||
        ''
    ).trim();

    const authorization = String(
        req.get('Authorization') || ''
    );

    let bearerToken = '';

    if (
        authorization.toLowerCase().startsWith('bearer ')
    ) {
        bearerToken = authorization
            .substring(7)
            .trim();
    }

    const token = headerToken || bearerToken;

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Missing connector token'
        });
    }

    if (
        token.length !== API_TOKEN.length ||
        !crypto.timingSafeEqual(
            Buffer.from(token),
            Buffer.from(API_TOKEN)
        )
    ) {
        return res.status(401).json({
            success: false,
            error: 'Invalid connector token'
        });
    }

    next();
}

/* =========================================================
   ACCOUNT DATABASE
========================================================= */

function getAccount(id) {
    const accounts = loadAccounts();

    return accounts.find(
        account => account.id === id
    ) || null;
}

function updateAccount(id, patch) {
    const accounts = loadAccounts();

    const index = accounts.findIndex(
        account => account.id === id
    );

    if (index === -1) {
        return null;
    }

    accounts[index] = {
        ...accounts[index],
        ...patch,
        updated_at: now()
    };

    saveAccounts(accounts);

    return accounts[index];
}

function createAccount(data) {
    const accounts = loadAccounts();

    const id = cleanString(
        data.id || makeId('wa'),
        80
    );

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        throw new Error(
            'Account ID may contain only letters, numbers, underscore and hyphen'
        );
    }

    if (
        accounts.some(account => account.id === id)
    ) {
        throw new Error('Account already exists');
    }

    const account = {
        id,
        account_name: cleanString(
            data.account_name || data.name || id,
            100
        ),

        phone: normalizePhone(
            data.phone || ''
        ),

        status: 'disconnected',
        connected: false,

        qr_available: false,
        qr_image: null,
        qr_expires_at: null,

        pairing_code: null,

        connected_at: null,
        last_error: null,

        created_at: now(),
        updated_at: now()
    };

    accounts.push(account);

    saveAccounts(accounts);

    return account;
}

function publicAccount(account) {
    if (!account) {
        return null;
    }

    const runtime = sessions.get(account.id);

    return {
        id: account.id,

        account_name:
            account.account_name || account.name || account.id,

        phone:
            account.phone ||
            runtime?.phone ||
            '',

        display_phone:
            displayPhone(
                account.phone ||
                runtime?.phone ||
                ''
            ),

        status:
            runtime?.status ||
            account.status ||
            'disconnected',

        connected:
            Boolean(
                runtime?.connected ??
                account.connected
            ),

        qr_available:
            Boolean(
                runtime?.qr_image ||
                account.qr_image
            ),

        qr_image:
            runtime?.qr_image ||
            account.qr_image ||
            null,

        qr_expires_at:
            runtime?.qr_expires_at ||
            account.qr_expires_at ||
            null,

        pairing_code:
            runtime?.pairing_code ||
            account.pairing_code ||
            null,

        connected_at:
            runtime?.connected_at ||
            account.connected_at ||
            null,

        last_error:
            runtime?.last_error ||
            account.last_error ||
            null,

        created_at: account.created_at,
        updated_at: account.updated_at
    };
}

/* =========================================================
   SESSION STATE
========================================================= */

function createRuntime(accountId) {
    if (sessions.has(accountId)) {
        return sessions.get(accountId);
    }

    const state = {
        id: accountId,

        sock: null,

        connecting: false,
        connected: false,

        status: 'disconnected',

        phone: '',

        qr: null,
        qr_image: null,
        qr_expires_at: null,

        pairing_code: null,

        connected_at: null,

        last_error: null,

        reconnect_attempts: 0,

        shouldReconnect: true,

        disconnecting: false,

        initialized: false,

        last_event_at: now(),

        bulk_running: false
    };

    sessions.set(accountId, state);

    return state;
}

function updateRuntime(accountId, patch) {
    const state = createRuntime(accountId);

    Object.assign(
        state,
        patch,
        {
            last_event_at: now()
        }
    );

    const dbPatch = {};

    const allowed = [
        'phone',
        'status',
        'connected',
        'qr_image',
        'qr_expires_at',
        'pairing_code',
        'connected_at',
        'last_error'
    ];

    for (const key of allowed) {
        if (
            Object.prototype.hasOwnProperty.call(
                patch,
                key
            )
        ) {
            dbPatch[key] = patch[key];
        }
    }

    if (Object.keys(dbPatch).length) {
        updateAccount(accountId, dbPatch);
    }

    return state;
}

/* =========================================================
   SESSION PATH
========================================================= */

function sessionPath(accountId) {
    return path.join(
        SESSION_DIR,
        accountId
    );
}

/* =========================================================
   BAILEYS SOCKET
========================================================= */

async function createSocket(accountId, options = {}) {
    if (shuttingDown) {
        throw new Error('Connector is shutting down');
    }

    const account = getAccount(accountId);

    if (!account) {
        throw new Error('Account not found');
    }

    const state = createRuntime(accountId);

    if (state.connecting) {
        return state;
    }

    if (
        state.sock &&
        state.connected
    ) {
        return state;
    }

    state.connecting = true;
    state.disconnecting = false;
    state.shouldReconnect = true;

    updateRuntime(accountId, {
        status: 'connecting',
        connected: false,
        last_error: null
    });

    try {
        ensureDir(sessionPath(accountId));

        const {
            state: authState,
            saveCreds
        } = await useMultiFileAuthState(
            sessionPath(accountId)
        );

        let version;

        try {
            const latest =
                await fetchLatestBaileysVersion();

            version = latest.version;
        } catch (error) {
            logger.warn({
                accountId,
                error: safeError(error)
            }, 'Could not fetch latest Baileys version');

            /*
             * Baileys can normally determine a compatible
             * version itself. We therefore don't fail the
             * whole connector here.
             */
            version = undefined;
        }

        const socketOptions = {
            auth: {
                creds: authState.creds,

                keys: makeCacheableSignalKeyStore(
                    authState.keys,
                    logger
                )
            },

            printQRInTerminal: false,

            browser: [
                'RB WhatsApp Connector',
                'Chrome',
                '1.0.0'
            ],

            markOnlineOnConnect: false,

            syncFullHistory: false,

            generateHighQualityLinkPreview: false,

            shouldIgnoreJid: jid => {
                return jid === 'status@broadcast';
            },

            logger
        };

        if (version) {
            socketOptions.version = version;
        }

        const sock =
            makeWASocket(socketOptions);

        state.sock = sock;
        state.initialized = true;

        sock.ev.on(
            'creds.update',
            async () => {
                try {
                    await saveCreds();
                } catch (error) {
                    logger.error({
                        accountId,
                        error: safeError(error)
                    }, 'Failed saving credentials');
                }
            }
        );

        sock.ev.on(
            'connection.update',
            async update => {
                await handleConnectionUpdate(
                    accountId,
                    update
                );
            }
        );

        sock.ev.on(
            'messages.upsert',
            async event => {
                handleMessages(
                    accountId,
                    event
                );
            }
        );

        state.connecting = false;

        logger.info({
            accountId
        }, 'WhatsApp socket initialized');

        return state;

    } catch (error) {
        state.connecting = false;
        state.sock = null;

        updateRuntime(accountId, {
            status: 'error',
            connected: false,
            last_error: safeError(error)
        });

        logger.error({
            accountId,
            error: safeError(error)
        }, 'Socket creation failed');

        throw error;
    }
}

/* =========================================================
   CONNECTION UPDATE
========================================================= */

async function handleConnectionUpdate(
    accountId,
    update
) {
    const state = createRuntime(accountId);

    const {
        connection,
        lastDisconnect,
        qr
    } = update;

    state.last_event_at = now();

    if (qr) {
        try {
            const qrImage =
                await QRCode.toDataURL(qr, {
                    margin: 1,
                    width: 360
                });

            const expiresAt =
                Date.now() + (60 * 1000);

            updateRuntime(accountId, {
                status: 'qr',
                connected: false,
                qr,
                qr_image: qrImage,
                qr_expires_at:
                    new Date(expiresAt).toISOString(),
                pairing_code: null,
                last_error: null
            });

            logger.info({
                accountId
            }, 'QR generated');

        } catch (error) {
            logger.error({
                accountId,
                error: safeError(error)
            }, 'QR generation failed');
        }
    }

    if (connection === 'connecting') {
        updateRuntime(accountId, {
            status: 'connecting',
            connected: false
        });

        return;
    }

    if (connection === 'open') {
        const jid =
            state.sock?.user?.id || '';

        const phone =
            normalizePhone(
                jid.split(':')[0]
                    .split('@')[0]
            );

        state.reconnect_attempts = 0;

        updateRuntime(accountId, {
            status: 'connected',
            connected: true,

            phone:
                phone ||
                state.phone ||
                getAccount(accountId)?.phone ||
                '',

            qr: null,
            qr_image: null,
            qr_expires_at: null,

            pairing_code: null,

            connected_at: now(),
            last_error: null
        });

        logger.info({
            accountId,
            phone
        }, 'WhatsApp connected');

        return;
    }

    if (connection === 'close') {
        const statusCode =
            lastDisconnect?.error?.output?.statusCode;

        const shouldReconnect =
            statusCode !==
            DisconnectReason.loggedOut &&
            statusCode !==
            DisconnectReason.forbidden &&
            statusCode !==
            DisconnectReason.badSession &&
            !state.disconnecting &&
            state.shouldReconnect &&
            !shuttingDown;

        state.sock = null;
        state.connecting = false;
        state.connected = false;

        let status = 'disconnected';

        if (
            statusCode === DisconnectReason.loggedOut
        ) {
            status = 'logged_out';
        } else if (
            statusCode === DisconnectReason.forbidden
        ) {
            status = 'forbidden';
        } else if (
            statusCode === DisconnectReason.badSession
        ) {
            status = 'bad_session';
        } else if (
            shouldReconnect
        ) {
            status = 'reconnecting';
        }

        updateRuntime(accountId, {
            status,
            connected: false,
            qr: null,
            qr_image: null,
            qr_expires_at: null,
            pairing_code: null,
            last_error:
                status === 'disconnected'
                    ? null
                    : `Connection closed (${statusCode || 'unknown'})`
        });

        logger.warn({
            accountId,
            statusCode,
            shouldReconnect
        }, 'WhatsApp connection closed');

        if (
            statusCode === DisconnectReason.loggedOut ||
            statusCode === DisconnectReason.badSession
        ) {
            /*
             * Session is no longer usable.
             * We don't automatically delete files.
             * User can explicitly call reset.
             */
            return;
        }

        if (shouldReconnect) {
            scheduleReconnect(accountId);
        }
    }
}

/* =========================================================
   RECONNECT
========================================================= */

function scheduleReconnect(accountId) {
    const state = createRuntime(accountId);

    state.reconnect_attempts++;

    const attempt =
        Math.min(
            state.reconnect_attempts,
            6
        );

    const delay =
        Math.min(
            3000 * attempt,
            30000
        );

    logger.info({
        accountId,
        attempt,
        delay
    }, 'Scheduling reconnect');

    setTimeout(async () => {
        if (
            shuttingDown ||
            !state.shouldReconnect
        ) {
            return;
        }

        try {
            await createSocket(accountId);
        } catch (error) {
            logger.error({
                accountId,
                error: safeError(error)
            }, 'Reconnect failed');

            if (
                !shuttingDown &&
                state.shouldReconnect
            ) {
                scheduleReconnect(accountId);
            }
        }
    }, delay);
}

/* =========================================================
   MESSAGE EVENTS
========================================================= */

function handleMessages(
    accountId,
    event
) {
    try {
        if (!event?.messages) {
            return;
        }

        for (const message of event.messages) {
            if (!message?.key) {
                continue;
            }

            const from =
                message.key.remoteJid || '';

            const messageId =
                message.key.id || '';

            logger.info({
                accountId,
                from,
                messageId,
                fromMe: Boolean(message.key.fromMe)
            }, 'Message event');
        }
    } catch (error) {
        logger.error({
            accountId,
            error: safeError(error)
        }, 'Message handler error');
    }
}

/* =========================================================
   CONNECT
========================================================= */

async function connectAccount(accountId) {
    const account = getAccount(accountId);

    if (!account) {
        throw new Error('Account not found');
    }

    const state = createRuntime(accountId);

    state.shouldReconnect = true;
    state.disconnecting = false;

    if (
        state.sock &&
        state.connected
    ) {
        return publicAccount(account);
    }

    await createSocket(accountId);

    return publicAccount(
        getAccount(accountId)
    );
}

/* =========================================================
   DISCONNECT
========================================================= */

async function disconnectAccount(
    accountId,
    removeSession = false
) {
    const state = createRuntime(accountId);

    state.shouldReconnect = false;
    state.disconnecting = true;

    try {
        if (state.sock) {
            try {
                await state.sock.logout();
            } catch (error) {
                logger.warn({
                    accountId,
                    error: safeError(error)
                }, 'Logout failed');
            }

            state.sock = null;
        }
    } finally {
        state.connected = false;
        state.connecting = false;

        updateRuntime(accountId, {
            status: 'disconnected',
            connected: false,
            qr: null,
            qr_image: null,
            qr_expires_at: null,
            pairing_code: null
        });

        state.disconnecting = false;
    }

    if (removeSession) {
        await deleteSessionFolder(accountId);
    }

    return publicAccount(
        getAccount(accountId)
    );
}

/* =========================================================
   DELETE SESSION
========================================================= */

async function deleteSessionFolder(
    accountId
) {
    const folder =
        sessionPath(accountId);

    try {
        if (fs.existsSync(folder)) {
            fs.rmSync(folder, {
                recursive: true,
                force: true
            });
        }
    } catch (error) {
        logger.error({
            accountId,
            error: safeError(error)
        }, 'Session deletion failed');

        throw error;
    }
}

/* =========================================================
   RESET
========================================================= */

async function resetAccount(accountId) {
    const account = getAccount(accountId);

    if (!account) {
        throw new Error('Account not found');
    }

    await disconnectAccount(
        accountId,
        true
    );

    const state = createRuntime(accountId);

    state.shouldReconnect = true;
    state.sock = null;
    state.connected = false;
    state.connecting = false;

    updateRuntime(accountId, {
        phone: '',
        status: 'disconnected',
        connected: false,
        qr: null,
        qr_image: null,
        qr_expires_at: null,
        pairing_code: null,
        connected_at: null,
        last_error: null
    });

    return publicAccount(
        getAccount(accountId)
    );
}

/* =========================================================
   QR
========================================================= */

function getQR(accountId) {
    const account = getAccount(accountId);

    if (!account) {
        throw new Error('Account not found');
    }

    const state = createRuntime(accountId);

    const qrImage =
        state.qr_image ||
        account.qr_image ||
        null;

    const expiresAt =
        state.qr_expires_at ||
        account.qr_expires_at ||
        null;

    return {
        available: Boolean(qrImage),

        qr_image: qrImage,

        expires_at: expiresAt,

        expires_in:
            expiresAt
                ? Math.max(
                    0,
                    Math.floor(
                        (
                            new Date(expiresAt).getTime() -
                            Date.now()
                        ) / 1000
                    )
                )
                : 0
    };
}

/* =========================================================
   PAIRING CODE
========================================================= */

async function requestPairingCode(
    accountId,
    phone
) {
    const account = getAccount(accountId);

    if (!account) {
        throw new Error('Account not found');
    }

    const normalized =
        normalizePhone(phone);

    if (
        normalized.length < 8 ||
        normalized.length > 15
    ) {
        throw new Error(
            'Invalid phone number'
        );
    }

    const state = createRuntime(accountId);

    state.shouldReconnect = true;

    /*
     * Pairing code is requested from an initialized,
     * not-yet-registered socket.
     */
    if (
        !state.sock ||
        state.connected
    ) {
        if (state.connected) {
            throw new Error(
                'Account is already connected'
            );
        }

        await createSocket(accountId);
    }

    const currentState =
        createRuntime(accountId);

    if (
        !currentState.sock
    ) {
        throw new Error(
            'WhatsApp socket is not ready'
        );
    }

    try {
        /*
         * Baileys expects digits only.
         */
        const code =
            await currentState.sock.requestPairingCode(
                normalized
            );

        const formatted =
            String(code || '')
                .replace(/(.{4})/g, '$1-')
                .replace(/-$/, '');

        updateRuntime(accountId, {
            pairing_code: formatted,
            qr_image: null,
            qr: null,
            qr_expires_at: null,
            status: 'pairing',
            last_error: null
        });

        return {
            phone: normalized,
            pairing_code: formatted
        };

    } catch (error) {
        updateRuntime(accountId, {
            last_error: safeError(error)
        });

        throw error;
    }
}

/* =========================================================
   SOCKET VALIDATION
========================================================= */

function getConnectedSocket(accountId) {
    const account = getAccount(accountId);

    if (!account) {
        throw new Error('Account not found');
    }

    const state = createRuntime(accountId);

    if (
        !state.sock ||
        !state.connected
    ) {
        throw new Error(
            'WhatsApp account is not connected'
        );
    }

    return state.sock;
}

/* =========================================================
   SEND TEXT
========================================================= */

async function sendText(
    accountId,
    phone,
    message
) {
    const text =
        cleanString(message, 4000);

    if (!text) {
        throw new Error(
            'Message is required'
        );
    }

    const normalized =
        normalizePhone(phone);

    if (
        normalized.length < 8 ||
        normalized.length > 15
    ) {
        throw new Error(
            'Invalid recipient phone number'
        );
    }

    const sock =
        getConnectedSocket(accountId);

    const jid =
        jidFromPhone(normalized);

    const result =
        await sock.sendMessage(
            jid,
            {
                text
            }
        );

    return {
        success: true,

        message_id:
            result?.key?.id || null,

        to: normalized,

        jid
    };
}

/* =========================================================
   MEDIA TYPE
========================================================= */

function detectMediaType(
    type,
    mimetype
) {
    const normalized =
        String(type || '')
            .toLowerCase()
            .trim();

    const mime =
        String(mimetype || '')
            .toLowerCase()
            .trim();

    if (
        normalized === 'image' ||
        mime.startsWith('image/')
    ) {
        return 'image';
    }

    if (
        normalized === 'video' ||
        mime.startsWith('video/')
    ) {
        return 'video';
    }

    if (
        normalized === 'audio' ||
        mime.startsWith('audio/')
    ) {
        return 'audio';
    }

    return 'document';
}

/* =========================================================
   SEND MEDIA
========================================================= */

async function sendMedia(
    accountId,
    phone,
    data
) {
    const normalized =
        normalizePhone(phone);

    if (
        normalized.length < 8 ||
        normalized.length > 15
    ) {
        throw new Error(
            'Invalid recipient phone number'
        );
    }

    const url =
        cleanString(data.url, 4000);

    if (!url) {
        throw new Error(
            'Media URL is required'
        );
    }

    /*
     * Only http/https URLs.
     */
    let parsedUrl;

    try {
        parsedUrl = new URL(url);
    } catch {
        throw new Error(
            'Invalid media URL'
        );
    }

    if (
        !['http:', 'https:']
            .includes(parsedUrl.protocol)
    ) {
        throw new Error(
            'Only HTTP/HTTPS media URLs are allowed'
        );
    }

    const sock =
        getConnectedSocket(accountId);

    const jid =
        jidFromPhone(normalized);

    const type =
        detectMediaType(
            data.type,
            data.mimetype
        );

    const caption =
        cleanString(
            data.caption || '',
            2000
        );

    const mimetype =
        cleanString(
            data.mimetype || '',
            200
        );

    let content;

    if (type === 'image') {
        content = {
            image: {
                url
            }
        };

        if (caption) {
            content.caption = caption;
        }

        if (mimetype) {
            content.mimetype = mimetype;
        }

    } else if (type === 'video') {
        content = {
            video: {
                url
            }
        };

        if (caption) {
            content.caption = caption;
        }

        if (mimetype) {
            content.mimetype = mimetype;
        }

    } else if (type === 'audio') {
        content = {
            audio: {
                url
            }
        };

        content.ptt =
            Boolean(data.ptt);

        if (mimetype) {
            content.mimetype = mimetype;
        }

    } else {
        content = {
            document: {
                url
            },

            fileName:
                cleanString(
                    data.fileName ||
                    data.filename ||
                    'document',
                    255
                )
        };

        if (caption) {
            content.caption = caption;
        }

        if (mimetype) {
            content.mimetype = mimetype;
        }
    }

    const result =
        await sock.sendMessage(
            jid,
            content
        );

    return {
        success: true,

        message_id:
            result?.key?.id || null,

        to: normalized,

        jid,

        type
    };
}

/* =========================================================
   BULK VALIDATION
========================================================= */

function normalizeRecipients(
    recipients
) {
    if (typeof recipients === 'string') {
        recipients =
            recipients
                .split(/\r?\n|,|;/)
                .map(item => item.trim());
    }

    if (!Array.isArray(recipients)) {
        throw new Error(
            'Recipients must be an array or text list'
        );
    }

    const result = [];

    const seen = new Set();

    for (const recipient of recipients) {
        const phone =
            normalizePhone(recipient);

        if (
            phone.length < 8 ||
            phone.length > 15
        ) {
            continue;
        }

        if (seen.has(phone)) {
            continue;
        }

        seen.add(phone);
        result.push(phone);

        if (
            result.length >=
            MAX_BULK_RECIPIENTS
        ) {
            break;
        }
    }

    return result;
}

/* =========================================================
   BULK JOB
========================================================= */

async function runBulkJob(jobId) {
    const job =
        bulkJobs.get(jobId);

    if (!job) {
        return;
    }

    const recipients =
        Array.isArray(job.recipients)
            ? job.recipients
            : [];

    job.status = 'running';
    job.started_at = now();

    job.total = recipients.length;
    job.sent = 0;
    job.failed = 0;
    job.remaining = recipients.length;

    saveBulkJob(job);

    for (
        let index = 0;
        index < recipients.length;
        index++
    ) {
        if (shuttingDown) {
            job.status = 'stopped';
            job.error =
                'Connector shutting down';

            break;
        }

        if (job.cancelled) {
            job.status = 'cancelled';
            break;
        }

        const phone =
            recipients[index];

        try {
            /*
             * Re-check connection before each send.
             */
            const state =
                createRuntime(
                    job.account_id
                );

            if (
                !state.sock ||
                !state.connected
            ) {
                throw new Error(
                    'WhatsApp account disconnected'
                );
            }

            const result =
                await sendText(
                    job.account_id,
                    phone,
                    job.message
                );

            job.items.push({
                phone,
                status: 'sent',
                message_id:
                    result.message_id,
                at: now()
            });

            job.sent++;

        } catch (error) {
            job.failed++;

            job.items.push({
                phone,
                status: 'failed',
                error: safeError(error),
                at: now()
            });

            logger.error({
                jobId,
                accountId: job.account_id,
                phone,
                error: safeError(error)
            }, 'Bulk message failed');
        }

        job.remaining =
            Math.max(
                0,
                job.total -
                job.sent -
                job.failed
            );

        saveBulkJob(job);

        /*
         * Delay between recipients.
         * Never allow unsafe/zero delay from API input.
         */
        if (
            index <
            recipients.length - 1
        ) {
            await sleep(
                Math.max(
                    MIN_BULK_DELAY,
                    job.delay
                )
            );
        }
    }

    if (
        job.status === 'running'
    ) {
        job.status = 'completed';
    }

    job.remaining =
        Math.max(
            0,
            job.total -
            job.sent -
            job.failed
        );

    job.finished_at = now();

    saveBulkJob(job);

    const state =
        createRuntime(
            job.account_id
        );

    state.bulk_running = false;

    logger.info({
        jobId,
        accountId: job.account_id,
        total: job.total,
        sent: job.sent,
        failed: job.failed
    }, 'Bulk job finished');
}

function saveBulkJob(job) {
    bulkJobs.set(
        job.id,
        job
    );

    /*
     * Persist summary without keeping
     * giant recipient arrays in JSON.
     */
    const jobs =
        loadJobs();

    const summary = {
        id: job.id,
        account_id: job.account_id,
        status: job.status,

        total: job.total,
        sent: job.sent,
        failed: job.failed,
        remaining: job.remaining,

        delay: job.delay,

        created_at: job.created_at,
        started_at: job.started_at || null,
        finished_at: job.finished_at || null,

        error: job.error || null
    };

    const index =
        jobs.findIndex(
            item => item.id === job.id
        );

    if (index === -1) {
        jobs.push(summary);
    } else {
        jobs[index] = summary;
    }

    saveJobs(jobs);
}

function createBulkJob(
    accountId,
    recipients,
    message,
    delay
) {
    const state =
        createRuntime(accountId);

    if (state.bulk_running) {
        throw new Error(
            'A bulk job is already running for this account'
        );
    }

    const normalized =
        normalizeRecipients(
            recipients
        );

    if (!normalized.length) {
        throw new Error(
            'No valid recipients supplied'
        );
    }

    if (normalized.length > MAX_BULK_RECIPIENTS) {
        throw new Error(
            `Maximum ${MAX_BULK_RECIPIENTS} recipients allowed`
        );
    }

    const cleanMessage =
        cleanString(
            message,
            4000
        );

    if (!cleanMessage) {
        throw new Error(
            'Bulk message is required'
        );
    }

    const safeDelay =
        Math.max(
            MIN_BULK_DELAY,
            Number(delay) ||
            DEFAULT_BULK_DELAY
        );

    const job = {
        id: makeId('bulk'),

        account_id: accountId,

        recipients: normalized,

        message: cleanMessage,

        delay: safeDelay,

        status: 'queued',

        total: normalized.length,
        sent: 0,
        failed: 0,
        remaining: normalized.length,

        items: [],

        created_at: now(),

        started_at: null,
        finished_at: null,

        cancelled: false,

        error: null
    };

    bulkJobs.set(
        job.id,
        job
    );

    saveBulkJob(job);

    state.bulk_running = true;

    /*
     * Start asynchronously.
     */
    setImmediate(() => {
        runBulkJob(job.id)
            .catch(error => {
                logger.error({
                    jobId: job.id,
                    error: safeError(error)
                }, 'Bulk worker crashed');

                const current =
                    bulkJobs.get(job.id);

                if (current) {
                    current.status = 'failed';
                    current.error =
                        safeError(error);
                    current.finished_at =
                        now();

                    saveBulkJob(current);
                }

                state.bulk_running = false;
            });
    });

    return job;
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
    '/health',
    (req, res) => {
        const accounts =
            loadAccounts();

        let connected = 0;

        for (const account of accounts) {
            const state =
                sessions.get(account.id);

            if (
                state?.connected
            ) {
                connected++;
            }
        }

        res.json({
            success: true,

            service:
                'RB WhatsApp Connector',

            version:
                '2.0.0',

            status:
                shuttingDown
                    ? 'shutting_down'
                    : 'online',

            uptime:
                Math.floor(
                    process.uptime()
                ),

            accounts:
                accounts.length,

            connected,

            timestamp: now()
        });
    }
);

/* =========================================================
   ACCOUNTS
========================================================= */

app.get(
    '/api/accounts',
    requireApiToken,
    (req, res) => {
        const accounts =
            loadAccounts()
                .map(publicAccount);

        res.json({
            success: true,
            accounts
        });
    }
);

app.post(
    '/api/accounts',
    requireApiToken,
    (req, res) => {
        try {
            const account =
                createAccount({
                    id: req.body.id,

                    account_name:
                        req.body.account_name ||
                        req.body.name,

                    phone:
                        req.body.phone
                });

            res.status(201).json({
                success: true,
                account:
                    publicAccount(account)
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

app.get(
    '/api/accounts/:id',
    requireApiToken,
    (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404).json({
                success: false,
                error: 'Account not found'
            });
        }

        res.json({
            success: true,

            account:
                publicAccount(account)
        });
    }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
    '/api/accounts/:id/status',
    requireApiToken,
    (req, res) => {
        const account =
            getAccount(
                req.params.id
            );

        if (!account) {
            return res.status(404).json({
                success: false,
                error: 'Account not found'
            });
        }

        res.json({
            success: true,

            account:
                publicAccount(account)
        });
    }
);

/*
 * Legacy status endpoint.
 *
 * Keeps compatibility with older PHP panels
 * when the account ID is supplied as query parameter.
 */
app.get(
    '/status',
    requireApiToken,
    (req, res) => {
        const id =
            cleanString(
                req.query.account_id ||
                req.query.id ||
                ''
            );

        if (!id) {
            return res.json({
                success: true,
                accounts:
                    loadAccounts()
                        .map(publicAccount)
            });
        }

        const account =
            getAccount(id);

        if (!account) {
            return res.status(404).json({
                success: false,
                error: 'Account not found'
            });
        }

        res.json({
            success: true,
            account:
                publicAccount(account)
        });
    }
);

/* =========================================================
   CONNECT
========================================================= */

app.post(
    '/api/accounts/:id/connect',
    requireApiToken,
    async (req, res) => {
        try {
            const account =
                await connectAccount(
                    req.params.id
                );

            res.json({
                success: true,
                account
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/*
 * Legacy connect endpoint.
 */
app.post(
    '/connect',
    requireApiToken,
    async (req, res) => {
        try {
            const id =
                cleanString(
                    req.body.account_id ||
                    req.body.id ||
                    ''
                );

            if (!id) {
                return res.status(400).json({
                    success: false,
                    error: 'account_id is required'
                });
            }

            const account =
                await connectAccount(id);

            res.json({
                success: true,
                account
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/* =========================================================
   QR
========================================================= */

app.get(
    '/api/accounts/:id/qr',
    requireApiToken,
    async (req, res) => {
        try {
            const account =
                getAccount(
                    req.params.id
                );

            if (!account) {
                return res.status(404).json({
                    success: false,
                    error: 'Account not found'
                });
            }

            const state =
                createRuntime(
                    req.params.id
                );

            /*
             * If no QR exists and account isn't connected,
             * initialize socket so Baileys can generate one.
             */
            if (
                !state.connected &&
                !state.qr_image &&
                !state.connecting
            ) {
                await createSocket(
                    req.params.id
                );
            }

            res.json({
                success: true,

                account_id:
                    req.params.id,

                ...getQR(
                    req.params.id
                )
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/*
 * Legacy QR endpoint.
 */
app.get(
    '/qr',
    requireApiToken,
    async (req, res) => {
        try {
            const id =
                cleanString(
                    req.query.account_id ||
                    req.query.id ||
                    ''
                );

            if (!id) {
                return res.status(400).json({
                    success: false,
                    error: 'account_id is required'
                });
            }

            const state =
                createRuntime(id);

            if (
                !state.connected &&
                !state.qr_image &&
                !state.connecting
            ) {
                await createSocket(id);
            }

            res.json({
                success: true,
                account_id: id,
                ...getQR(id)
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/* =========================================================
   PAIR
========================================================= */

app.post(
    '/api/accounts/:id/pair',
    requireApiToken,
    async (req, res) => {
        try {
            const phone =
                req.body.phone;

            const result =
                await requestPairingCode(
                    req.params.id,
                    phone
                );

            res.json({
                success: true,

                account_id:
                    req.params.id,

                ...result
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/*
 * Legacy pair.
 */
app.post(
    '/pair',
    requireApiToken,
    async (req, res) => {
        try {
            const id =
                cleanString(
                    req.body.account_id ||
                    req.body.id ||
                    ''
                );

            if (!id) {
                return res.status(400).json({
                    success: false,
                    error: 'account_id is required'
                });
            }

            const result =
                await requestPairingCode(
                    id,
                    req.body.phone
                );

            res.json({
                success: true,
                account_id: id,
                ...result
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/* =========================================================
   DISCONNECT
========================================================= */

app.post(
    '/api/accounts/:id/disconnect',
    requireApiToken,
    async (req, res) => {
        try {
            const account =
                await disconnectAccount(
                    req.params.id,
                    false
                );

            res.json({
                success: true,
                account
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/*
 * Legacy disconnect.
 */
app.post(
    '/disconnect',
    requireApiToken,
    async (req, res) => {
        try {
            const id =
                cleanString(
                    req.body.account_id ||
                    req.body.id ||
                    ''
                );

            if (!id) {
                return res.status(400).json({
                    success: false,
                    error: 'account_id is required'
                });
            }

            const account =
                await disconnectAccount(
                    id,
                    false
                );

            res.json({
                success: true,
                account
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/* =========================================================
   RESET
========================================================= */

app.post(
    '/api/accounts/:id/reset',
    requireApiToken,
    async (req, res) => {
        try {
            const account =
                await resetAccount(
                    req.params.id
                );

            res.json({
                success: true,
                account
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/*
 * Legacy reset.
 */
app.post(
    '/reset',
    requireApiToken,
    async (req, res) => {
        try {
            const id =
                cleanString(
                    req.body.account_id ||
                    req.body.id ||
                    ''
                );

            if (!id) {
                return res.status(400).json({
                    success: false,
                    error: 'account_id is required'
                });
            }

            const account =
                await resetAccount(id);

            res.json({
                success: true,
                account
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/* =========================================================
   DELETE ACCOUNT
========================================================= */

app.delete(
    '/api/accounts/:id',
    requireApiToken,
    async (req, res) => {
        try {
            const id =
                req.params.id;

            const account =
                getAccount(id);

            if (!account) {
                return res.status(404).json({
                    success: false,
                    error: 'Account not found'
                });
            }

            await disconnectAccount(
                id,
                true
            );

            const accounts =
                loadAccounts()
                    .filter(
                        item => item.id !== id
                    );

            saveAccounts(accounts);

            sessions.delete(id);

            res.json({
                success: true,
                message:
                    'Account deleted'
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/* =========================================================
   SEND MESSAGE
========================================================= */

app.post(
    '/api/send-message',
    requireApiToken,
    async (req, res) => {
        try {
            const accountId =
                cleanString(
                    req.body.account_id ||
                    req.body.id ||
                    ''
                );

            const phone =
                req.body.phone ||
                req.body.to;

            const message =
                req.body.message ||
                req.body.text;

            if (!accountId) {
                return res.status(400).json({
                    success: false,
                    error: 'account_id is required'
                });
            }

            const result =
                await sendText(
                    accountId,
                    phone,
                    message
                );

            res.json({
                success: true,
                ...result
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/*
 * Legacy send endpoint.
 */
app.post(
    '/send-message',
    requireApiToken,
    async (req, res) => {
        try {
            const accountId =
                cleanString(
                    req.body.account_id ||
                    req.body.id ||
                    ''
                );

            const result =
                await sendText(
                    accountId,
                    req.body.phone ||
                    req.body.to,
                    req.body.message ||
                    req.body.text
                );

            res.json({
                success: true,
                ...result
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/* =========================================================
   SEND MEDIA
========================================================= */

app.post(
    '/api/send-media',
    requireApiToken,
    async (req, res) => {
        try {
            const accountId =
                cleanString(
                    req.body.account_id ||
                    req.body.id ||
                    ''
                );

            const result =
                await sendMedia(
                    accountId,
                    req.body.phone ||
                    req.body.to,
                    req.body
                );

            res.json({
                success: true,
                ...result
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/*
 * Legacy media endpoint.
 */
app.post(
    '/send-media',
    requireApiToken,
    async (req, res) => {
        try {
            const accountId =
                cleanString(
                    req.body.account_id ||
                    req.body.id ||
                    ''
                );

            const result =
                await sendMedia(
                    accountId,
                    req.body.phone ||
                    req.body.to,
                    req.body
                );

            res.json({
                success: true,
                ...result
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/* =========================================================
   BULK
========================================================= */

app.post(
    '/api/bulk',
    requireApiToken,
    async (req, res) => {
        try {
            const accountId =
                cleanString(
                    req.body.account_id ||
                    req.body.id ||
                    ''
                );

            if (!accountId) {
                return res.status(400).json({
                    success: false,
                    error: 'account_id is required'
                });
            }

            const account =
                getAccount(accountId);

            if (!account) {
                return res.status(404).json({
                    success: false,
                    error: 'Account not found'
                });
            }

            const state =
                createRuntime(accountId);

            if (
                !state.connected
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'WhatsApp account is not connected'
                });
            }

            const job =
                createBulkJob(
                    accountId,

                    req.body.recipients ||
                    req.body.numbers ||
                    req.body.phones,

                    req.body.message ||
                    req.body.text,

                    req.body.delay
                );

            res.status(202).json({
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
                        job.created_at
                }
            });

        } catch (error) {
            res.status(400).json({
                success: false,
                error: safeError(error)
            });
        }
    }
);

/* =========================================================
   BULK STATUS
========================================================= */

app.get(
    '/api/bulk/:jobId',
    requireApiToken,
    (req, res) => {
        const job =
            bulkJobs.get(
                req.params.jobId
            );

        if (job) {
            return res.json({
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

                    finished_at:
                        job.finished_at,

                    error:
                        job.error || null
                }
            });
        }

        const savedJobs =
            loadJobs();

        const saved =
            savedJobs.find(
                item =>
                    item.id ===
                    req.params.jobId
            );

        if (!saved) {
            return res.status(404).json({
                success: false,
                error: 'Bulk job not found'
            });
        }

        res.json({
            success: true,
            job: saved
        });
    }
);

/* =========================================================
   BULK CANCEL
========================================================= */

app.post(
    '/api/bulk/:jobId/cancel',
    requireApiToken,
    (req, res) => {
        const job =
            bulkJobs.get(
                req.params.jobId
            );

        if (!job) {
            return res.status(404).json({
                success: false,
                error: 'Bulk job not found'
            });
        }

        if (
            job.status === 'completed' ||
            job.status === 'failed' ||
            job.status === 'cancelled'
        ) {
            return res.status(400).json({
                success: false,
                error: 'Job is already finished'
            });
        }

        job.cancelled = true;

        res.json({
            success: true,

            message:
                'Cancellation requested',

            job_id:
                job.id
        });
    }
);

/* =========================================================
   JOB HISTORY
========================================================= */

app.get(
    '/api/bulk',
    requireApiToken,
    (req, res) => {
        const jobs =
            loadJobs();

        const accountId =
            cleanString(
                req.query.account_id ||
                ''
            );

        let result =
            jobs.slice().reverse();

        if (accountId) {
            result =
                result.filter(
                    job =>
                        job.account_id ===
                        accountId
                );
        }

        res.json({
            success: true,
            jobs: result.slice(0, 100)
        });
    }
);

/* =========================================================
   DEBUG-SAFE ERROR HANDLER
========================================================= */

app.use(
    (req, res) => {
        res.status(404).json({
            success: false,
            error: 'Endpoint not found'
        });
    }
);

app.use(
    (error, req, res, next) => {
        logger.error({
            error: safeError(error),
            method: req.method,
            path: req.path
        }, 'Unhandled Express error');

        if (res.headersSent) {
            return next(error);
        }

        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
);

/* =========================================================
   LOAD EXISTING ACCOUNTS
========================================================= */

function initializeExistingAccounts() {
    const accounts =
        loadAccounts();

    for (const account of accounts) {
        createRuntime(account.id);
    }

    logger.info({
        count: accounts.length
    }, 'Existing accounts loaded');
}

/* =========================================================
   OPTIONAL AUTO CONNECT
========================================================= */

async function autoConnectAccounts() {
    const accounts =
        loadAccounts();

    /*
     * Auto-connect is enabled by default.
     *
     * Set:
     * AUTO_CONNECT=false
     *
     * if you want the PHP panel to initiate
     * every connection manually.
     */
    const autoConnect =
        String(
            process.env.AUTO_CONNECT || 'true'
        ).toLowerCase() !== 'false';

    if (!autoConnect) {
        logger.info(
            'AUTO_CONNECT disabled'
        );

        return;
    }

    for (const account of accounts) {
        if (shuttingDown) {
            break;
        }

        try {
            await connectAccount(
                account.id
            );

            /*
             * Small gap between account
             * initializations.
             */
            await sleep(500);

        } catch (error) {
            logger.warn({
                accountId: account.id,
                error: safeError(error)
            }, 'Auto-connect failed');
        }
    }
}

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(
    signal
) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    logger.info({
        signal
    }, 'Connector shutting down');

    for (const [
        accountId,
        state
    ] of sessions.entries()) {
        state.shouldReconnect = false;
        state.disconnecting = true;

        try {
            if (state.sock) {
                /*
                 * Do not logout here.
                 *
                 * Logging out would destroy the WhatsApp
                 * login session every time Railway restarts.
                 */
                try {
                    state.sock.ws?.close();
                } catch {}

                state.sock = null;
            }
        } catch (error) {
            logger.warn({
                accountId,
                error: safeError(error)
            }, 'Socket shutdown error');
        }
    }

    try {
        server.close(() => {
            logger.info(
                'HTTP server closed'
            );

            process.exit(0);
        });

        setTimeout(() => {
            process.exit(0);
        }, 8000);

    } catch {
        process.exit(0);
    }
}

process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

process.on(
    'SIGINT',
    () => shutdown('SIGINT')
);

process.on(
    'uncaughtException',
    error => {
        logger.error({
            error: safeError(error)
        }, 'Uncaught exception');

        /*
         * Don't immediately kill the whole connector.
         * Most operational errors are handled at their source.
         */
    }
);

process.on(
    'unhandledRejection',
    error => {
        logger.error({
            error: safeError(error)
        }, 'Unhandled promise rejection');
    }
);

/* =========================================================
   START SERVER
========================================================= */

initializeExistingAccounts();

const server =
    app.listen(
        PORT,
        '0.0.0.0',
        async () => {
            logger.info(
                `RB WhatsApp Connector listening on port ${PORT}`
            );

            logger.info({
                dataDir: DATA_DIR,
                sessionDir: SESSION_DIR
            }, 'Storage configuration');

            logger.info(
                'Connector ready'
            );

            /*
             * Don't block HTTP startup while accounts
             * reconnect.
             */
            setTimeout(() => {
                autoConnectAccounts()
                    .catch(error => {
                        logger.error({
                            error: safeError(error)
                        }, 'Auto-connect process failed');
                    });
            }, 1000);
        }
    );
