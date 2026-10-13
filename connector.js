'use strict';

/*
|--------------------------------------------------------------------------
| WhatsApp Connector - Compliance First
|--------------------------------------------------------------------------
| Node.js + Express + Baileys
|
| Features:
| - WhatsApp QR connection
| - Pairing code
| - Automatic reconnect
| - Auto-online presence
| - Incoming message webhook
| - 24-hour inbound window tracking
| - Opt-in / opt-out protection
| - Group-message protection
| - Self-message protection
| - Conservative outbound rate limiting
| - Campaign safety limits
| - Automatic campaign pause after errors
| - Send text
| - Send media
| - Health/status
| - Reset/disconnect
|
| IMPORTANT:
| This code cannot guarantee "no account ban".
| Compliance depends on your actual message content,
| consent, user reports, account history and WhatsApp enforcement.
|--------------------------------------------------------------------------
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
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    delay
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode');

const app = express();

app.use(express.json({
    limit: '10mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '10mb'
}));

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const PORT = Number(process.env.PORT || 3000);

const API_TOKEN =
    process.env.CONNECTOR_API_TOKEN ||
    'RBWA_9fK7x2Pq8Lm4N';

const WEBHOOK_URL =
    process.env.WEBHOOK_URL ||
    '';

const WEBHOOK_SECRET =
    process.env.WEBHOOK_SECRET ||
    '';

const DEFAULT_COUNTRY =
    process.env.DEFAULT_COUNTRY ||
    'IN';

/*
|--------------------------------------------------------------------------
| Compliance configuration
|--------------------------------------------------------------------------
*/

const COMPLIANCE = {

    // Groups ignored by default.
    IGNORE_GROUPS:
        String(process.env.IGNORE_GROUPS || 'true') !== 'false',

    // Ignore messages sent by the WhatsApp account itself.
    IGNORE_FROM_ME:
        String(process.env.IGNORE_FROM_ME || 'true') !== 'false',

    // Automatically mark incoming chats as read.
    MARK_READ:
        String(process.env.MARK_READ || 'false') === 'true',

    // Show online presence when an inbound message arrives.
    AUTO_ONLINE:
        String(process.env.AUTO_ONLINE || 'true') !== 'false',

    // 24-hour customer service window.
    CUSTOMER_WINDOW_MS:
        24 * 60 * 60 * 1000,

    /*
     * Minimum delay between outbound messages.
     * This is deliberately conservative.
     */
    MIN_OUTBOUND_DELAY_MS:
        Number(process.env.MIN_OUTBOUND_DELAY_MS || 5000),

    /*
     * Maximum outbound messages per hour.
     *
     * This is a safety ceiling, NOT a WhatsApp-approved limit.
     * Adjust only according to your legitimate, consented use.
     */
    MAX_OUTBOUND_PER_HOUR:
        Number(process.env.MAX_OUTBOUND_PER_HOUR || 100),

    /*
     * Maximum consecutive outbound errors before
     * campaign sending is automatically paused.
     */
    MAX_CONSECUTIVE_ERRORS:
        Number(process.env.MAX_CONSECUTIVE_ERRORS || 5),

    /*
     * Maximum campaign size per request.
     */
    MAX_CAMPAIGN_SIZE:
        Number(process.env.MAX_CAMPAIGN_SIZE || 100),

    /*
     * Require campaign opt-in.
     *
     * true = campaign requests require opt-in.
     */
    REQUIRE_OPT_IN_FOR_CAMPAIGN:
        String(
            process.env.REQUIRE_OPT_IN_FOR_CAMPAIGN || 'true'
        ) !== 'false'
};

/*
|--------------------------------------------------------------------------
| Directories
|--------------------------------------------------------------------------
*/

const DATA_DIR =
    process.env.DATA_DIR ||
    path.join(__dirname, 'data');

const AUTH_DIR =
    process.env.AUTH_DIR ||
    path.join(__dirname, 'auth');

const LOG_DIR =
    path.join(DATA_DIR, 'logs');

const DATA_FILE =
    path.join(DATA_DIR, 'contacts.json');

const CAMPAIGN_FILE =
    path.join(DATA_DIR, 'campaign.json');

const QR_FILE =
    path.join(DATA_DIR, 'qr.png');

[
    DATA_DIR,
    AUTH_DIR,
    LOG_DIR
].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {
            recursive: true
        });
    }
});

/*
|--------------------------------------------------------------------------
| Logger
|--------------------------------------------------------------------------
*/

const logger = pino({
    level: process.env.LOG_LEVEL || 'info'
});

/*
|--------------------------------------------------------------------------
| Runtime state
|--------------------------------------------------------------------------
*/

let sock = null;

let connectionState = {
    status: 'disconnected',
    connected: false,
    qr: null,
    qrExpiresAt: 0,
    phone: null,
    name: null,
    lastError: null,
    reconnecting: false
};

let reconnectTimer = null;

let reconnectAttempts = 0;

let lastOutboundAt = 0;

let outboundHistory = [];

let consecutiveOutboundErrors = 0;

let campaignPaused = false;

let incomingCount = 0;

let outgoingCount = 0;

let webhookCount = 0;

/*
|--------------------------------------------------------------------------
| Database helpers
|--------------------------------------------------------------------------
*/

function readJSON(file, fallback) {

    try {

        if (!fs.existsSync(file)) {
            return fallback;
        }

        const raw = fs.readFileSync(
            file,
            'utf8'
        );

        return JSON.parse(raw);

    } catch (error) {

        logger.error({
            file,
            error: error.message
        }, 'JSON read error');

        return fallback;
    }
}

function writeJSON(file, data) {

    const temp =
        `${file}.${process.pid}.tmp`;

    fs.writeFileSync(
        temp,
        JSON.stringify(data, null, 2),
        'utf8'
    );

    fs.renameSync(
        temp,
        file
    );
}

/*
|--------------------------------------------------------------------------
| Contact database
|--------------------------------------------------------------------------
*/

let contacts =
    readJSON(DATA_FILE, {});

function saveContacts() {

    writeJSON(
        DATA_FILE,
        contacts
    );
}

function normalizePhone(value) {

    if (!value) {
        return null;
    }

    let number =
        String(value)
            .replace(/\D/g, '');

    /*
     * Basic India normalization.
     * For international use, send full country-code numbers.
     */
    if (
        DEFAULT_COUNTRY === 'IN' &&
        number.length === 10
    ) {
        number = '91' + number;
    }

    return number || null;
}

function phoneFromJid(jid) {

    if (!jid) {
        return null;
    }

    const user =
        String(jid)
            .split('@')[0]
            .split(':')[0];

    return normalizePhone(user);
}

function isGroupJid(jid) {

    return String(jid || '')
        .endsWith('@g.us');
}

function ensureContact(number) {

    number =
        normalizePhone(number);

    if (!number) {
        return null;
    }

    if (!contacts[number]) {

        contacts[number] = {
            number,
            optedIn: false,
            optedOut: false,

            optInAt: null,
            optOutAt: null,

            optInSource: null,

            lastInboundAt: null,
            lastOutboundAt: null,

            firstSeenAt:
                new Date().toISOString(),

            inboundCount: 0,
            outboundCount: 0
        };

        saveContacts();
    }

    return contacts[number];
}

/*
|--------------------------------------------------------------------------
| Opt-in / opt-out
|--------------------------------------------------------------------------
*/

const OPT_OUT_WORDS = new Set([
    'stop',
    'unsubscribe',
    'cancel',
    'remove',
    'opt out',
    'optout',
    'do not message',
    'dont message',
    'no more',
    'block'
]);

const OPT_IN_WORDS = new Set([
    'start',
    'subscribe',
    'opt in',
    'optin',
    'yes',
    'unstop'
]);

function cleanCommand(text) {

    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/[.!?,;:]+$/g, '')
        .replace(/\s+/g, ' ');
}

function isOptOut(text) {

    return OPT_OUT_WORDS.has(
        cleanCommand(text)
    );
}

function isOptIn(text) {

    return OPT_IN_WORDS.has(
        cleanCommand(text)
    );
}

function applyOptOut(number, source = 'whatsapp') {

    const contact =
        ensureContact(number);

    if (!contact) {
        return false;
    }

    contact.optedIn = false;
    contact.optedOut = true;

    contact.optOutAt =
        new Date().toISOString();

    contact.optInSource = null;

    saveContacts();

    logger.info({
        number,
        source
    }, 'Contact opted out');

    return true;
}

function applyOptIn(
    number,
    source = 'whatsapp'
) {

    const contact =
        ensureContact(number);

    if (!contact) {
        return false;
    }

    contact.optedIn = true;
    contact.optedOut = false;

    contact.optInAt =
        new Date().toISOString();

    contact.optInSource =
        source;

    contact.optOutAt = null;

    saveContacts();

    logger.info({
        number,
        source
    }, 'Contact opted in');

    return true;
}

/*
|--------------------------------------------------------------------------
| 24-hour window
|--------------------------------------------------------------------------
*/

function withinCustomerWindow(number) {

    const contact =
        contacts[
            normalizePhone(number)
        ];

    if (!contact) {
        return false;
    }

    if (!contact.lastInboundAt) {
        return false;
    }

    const timestamp =
        new Date(
            contact.lastInboundAt
        ).getTime();

    return (
        Date.now() - timestamp
        <= COMPLIANCE.CUSTOMER_WINDOW_MS
    );
}

/*
|--------------------------------------------------------------------------
| Outbound rate protection
|--------------------------------------------------------------------------
*/

function cleanupOutboundHistory() {

    const oneHourAgo =
        Date.now() - 60 * 60 * 1000;

    outboundHistory =
        outboundHistory.filter(
            timestamp =>
                timestamp > oneHourAgo
        );
}

function hourlyOutboundCount() {

    cleanupOutboundHistory();

    return outboundHistory.length;
}

async function waitForOutboundSlot() {

    const now =
        Date.now();

    const elapsed =
        now - lastOutboundAt;

    const required =
        COMPLIANCE.MIN_OUTBOUND_DELAY_MS;

    if (elapsed < required) {

        await delay(
            required - elapsed
        );
    }

    cleanupOutboundHistory();

    if (
        outboundHistory.length >=
        COMPLIANCE.MAX_OUTBOUND_PER_HOUR
    ) {

        throw new Error(
            'OUTBOUND_RATE_LIMIT_REACHED'
        );
    }
}

function recordOutbound() {

    const now =
        Date.now();

    lastOutboundAt = now;

    outboundHistory.push(now);

    outgoingCount++;

    consecutiveOutboundErrors = 0;
}

function recordOutboundError(error) {

    consecutiveOutboundErrors++;

    logger.error({
        consecutiveOutboundErrors,
        error:
            error?.message || String(error)
    }, 'Outbound error');

    if (
        consecutiveOutboundErrors >=
        COMPLIANCE.MAX_CONSECUTIVE_ERRORS
    ) {

        campaignPaused = true;

        logger.warn(
            'Campaign sending automatically paused after repeated errors'
        );
    }
}

/*
|--------------------------------------------------------------------------
| Authentication
|--------------------------------------------------------------------------
*/

function getToken(req) {

    const authorization =
        req.headers.authorization || '';

    if (
        authorization
            .toLowerCase()
            .startsWith('bearer ')
    ) {

        return authorization
            .slice(7)
            .trim();
    }

    return (
        req.headers['x-api-token'] ||
        req.body?.api_token ||
        req.query?.api_token ||
        ''
    );
}

function authorized(req) {

    /*
     * Local health endpoint can optionally be public.
     */
    if (
        req.path === '/health' &&
        String(
            process.env.PUBLIC_HEALTH || 'true'
        ) === 'true'
    ) {
        return true;
    }

    if (!API_TOKEN) {
        return true;
    }

    return crypto.timingSafeEqual(
        Buffer.from(
            String(getToken(req))
        ),
        Buffer.from(
            String(API_TOKEN)
        )
    );
}

function requireAuth(req, res, next) {

    try {

        if (!authorized(req)) {

            return res.status(401).json({
                success: false,
                error: {
                    code: 'UNAUTHORIZED',
                    message:
                        'Missing or invalid API token'
                }
            });
        }

        next();

    } catch {

        return res.status(401).json({
            success: false,
            error: {
                code: 'UNAUTHORIZED',
                message:
                    'Missing or invalid API token'
            }
        });
    }
}

/*
|--------------------------------------------------------------------------
| QR helpers
|--------------------------------------------------------------------------
*/

async function createQR(qr) {

    connectionState.qr = qr;

    connectionState.qrExpiresAt =
        Date.now() + 5 * 60 * 1000;

    try {

        await qrcode.toFile(
            QR_FILE,
            qr,
            {
                width: 600,
                margin: 2
            }
        );

    } catch (error) {

        logger.error({
            error: error.message
        }, 'QR generation failed');
    }
}

function clearQR() {

    connectionState.qr = null;

    connectionState.qrExpiresAt = 0;

    try {

        if (fs.existsSync(QR_FILE)) {
            fs.unlinkSync(QR_FILE);
        }

    } catch {}
}

/*
|--------------------------------------------------------------------------
| Incoming message extraction
|--------------------------------------------------------------------------
*/

function extractMessageText(message) {

    if (!message) {
        return '';
    }

    if (message.conversation) {
        return message.conversation;
    }

    if (
        message.extendedTextMessage &&
        message.extendedTextMessage.text
    ) {
        return message.extendedTextMessage.text;
    }

    if (
        message.imageMessage &&
        message.imageMessage.caption
    ) {
        return message.imageMessage.caption;
    }

    if (
        message.videoMessage &&
        message.videoMessage.caption
    ) {
        return message.videoMessage.caption;
    }

    if (
        message.documentMessage &&
        message.documentMessage.caption
    ) {
        return message.documentMessage.caption;
    }

    return '';
}

/*
|--------------------------------------------------------------------------
| Webhook
|--------------------------------------------------------------------------
*/

async function sendWebhook(payload) {

    if (!WEBHOOK_URL) {
        return false;
    }

    try {

        const headers = {
            'Content-Type':
                'application/json',

            'User-Agent':
                'RBWA-Compliant-Connector/1.0'
        };

        if (WEBHOOK_SECRET) {

            headers[
                'X-Webhook-Secret'
            ] = WEBHOOK_SECRET;
        }

        const response =
            await fetch(
                WEBHOOK_URL,
                {
                    method: 'POST',
                    headers,
                    body:
                        JSON.stringify(payload)
                }
            );

        webhookCount++;

        if (!response.ok) {

            logger.warn({
                status: response.status
            }, 'Webhook returned non-2xx');

            return false;
        }

        return true;

    } catch (error) {

        logger.error({
            error: error.message
        }, 'Webhook failed');

        return false;
    }
}

/*
|--------------------------------------------------------------------------
| Process incoming message
|--------------------------------------------------------------------------
*/

async function handleIncomingMessage(msg) {

    try {

        if (!msg) {
            return;
        }

        const key =
            msg.key || {};

        const remoteJid =
            key.remoteJid;

        if (!remoteJid) {
            return;
        }

        /*
         * Ignore status broadcasts.
         */
        if (
            remoteJid === 'status@broadcast'
        ) {
            return;
        }

        /*
         * Ignore groups by default.
         */
        if (
            COMPLIANCE.IGNORE_GROUPS &&
            isGroupJid(remoteJid)
        ) {
            return;
        }

        /*
         * Ignore our own messages.
         */
        if (
            COMPLIANCE.IGNORE_FROM_ME &&
            key.fromMe
        ) {
            return;
        }

        const number =
            phoneFromJid(remoteJid);

        if (!number) {
            return;
        }

        const contact =
            ensureContact(number);

        if (!contact) {
            return;
        }

        const message =
            msg.message || {};

        const text =
            extractMessageText(message);

        const now =
            new Date().toISOString();

        contact.lastInboundAt = now;
        contact.inboundCount++;

        /*
         * A real incoming WhatsApp message does NOT
         * automatically mean marketing opt-in.
         *
         * It only opens the customer-service window.
         */

        if (isOptOut(text)) {

            applyOptOut(
                number,
                'whatsapp'
            );

        } else if (isOptIn(text)) {

            /*
             * Treat START/OPT IN as explicit
             * opt-in command.
             */
            applyOptIn(
                number,
                'whatsapp-command'
            );
        }

        saveContacts();

        incomingCount++;

        /*
         * Auto-online presence.
         */
        if (
            COMPLIANCE.AUTO_ONLINE &&
            sock
        ) {

            try {

                await sock.sendPresenceUpdate(
                    'available'
                );

            } catch {}
        }

        /*
         * Mark read only when explicitly enabled.
         */
        if (
            COMPLIANCE.MARK_READ &&
            sock &&
            key.id
        ) {

            try {

                await sock.readMessages([
                    key
                ]);

            } catch {}
        }

        const payload = {

            success: true,

            event: 'message',

            timestamp: now,

            number,

            from:
                remoteJid,

            sender:
                number,

            pushName:
                msg.pushName ||
                null,

            text,

            message: text,

            fromMe:
                Boolean(key.fromMe),

            isGroup:
                isGroupJid(remoteJid),

            optedIn:
                Boolean(contact.optedIn),

            optedOut:
                Boolean(contact.optedOut),

            customerWindow:
                withinCustomerWindow(number),

            /*
             * This is intentionally false unless the
             * customer explicitly opted in.
             */
            marketingAllowed:
                Boolean(
                    contact.optedIn &&
                    !contact.optedOut
                )
        };

        await sendWebhook(payload);

    } catch (error) {

        logger.error({
            error: error.message,
            stack: error.stack
        }, 'Incoming message processing error');
    }
}

/*
|--------------------------------------------------------------------------
| Connection
|--------------------------------------------------------------------------
*/

async function connectWhatsApp() {

    if (
        connectionState.reconnecting
    ) {
        return;
    }

    connectionState.reconnecting = true;

    try {

        connectionState.status =
            'connecting';

        connectionState.connected =
            false;

        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                AUTH_DIR
            );

        let version;

        try {

            const latest =
                await fetchLatestBaileysVersion();

            version =
                latest.version;

        } catch {

            version =
                undefined;
        }

        sock =
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

                logger: pino({
                    level: 'silent'
                }),

                printQRInTerminal: false,

                browser:
                    Browsers.macOS(
                        'Desktop'
                    ),

                markOnlineOnConnect: false,

                syncFullHistory: false,

                generateHighQualityLinkPreview:
                    false,

                connectTimeoutMs:
                    60_000,

                defaultQueryTimeoutMs:
                    60_000,

                keepAliveIntervalMs:
                    30_000
            });

        /*
         * Save credentials.
         */
        sock.ev.on(
            'creds.update',
            saveCreds
        );

        /*
         * Connection updates.
         */
        sock.ev.on(
            'connection.update',
            async update => {

                const {
                    connection,
                    lastDisconnect,
                    qr
                } = update;

                if (qr) {

                    await createQR(qr);

                    connectionState.status =
                        'qr';

                    connectionState.connected =
                        false;
                }

                if (
                    connection ===
                    'connecting'
                ) {

                    connectionState.status =
                        'connecting';

                    connectionState.connected =
                        false;
                }

                if (
                    connection ===
                    'open'
                ) {

                    reconnectAttempts = 0;

                    connectionState.status =
                        'connected';

                    connectionState.connected =
                        true;

                    connectionState.reconnecting =
                        false;

                    connectionState.lastError =
                        null;

                    clearQR();

                    try {

                        const user =
                            sock.user;

                        if (user) {

                            connectionState.phone =
                                phoneFromJid(
                                    user.id
                                );

                            connectionState.name =
                                user.name ||
                                null;
                        }

                    } catch {}

                    logger.info(
                        'WhatsApp connected'
                    );

                    try {

                        await sock.sendPresenceUpdate(
                            'available'
                        );

                    } catch {}
                }

                if (
                    connection ===
                    'close'
                ) {

                    connectionState.connected =
                        false;

                    connectionState.status =
                        'disconnected';

                    connectionState.reconnecting =
                        false;

                    const statusCode =
                        lastDisconnect
                            ?.error
                            ?.output
                            ?.statusCode;

                    const loggedOut =
                        statusCode ===
                        DisconnectReason.loggedOut;

                    const connectionClosed =
                        statusCode ===
                        DisconnectReason.connectionClosed;

                    const connectionLost =
                        statusCode ===
                        DisconnectReason.connectionLost;

                    const restartRequired =
                        statusCode ===
                        DisconnectReason.restartRequired;

                    logger.warn({
                        statusCode,
                        loggedOut,
                        connectionClosed,
                        connectionLost,
                        restartRequired
                    }, 'WhatsApp connection closed');

                    /*
                     * Do NOT repeatedly reconnect a logged-out
                     * account. The user must pair again.
                     */
                    if (loggedOut) {

                        connectionState.status =
                            'logged_out';

                        clearQR();

                        return;
                    }

                    scheduleReconnect();
                }
            }
        );

        /*
         * Incoming messages.
         */
        sock.ev.on(
            'messages.upsert',
            async event => {

                if (!event) {
                    return;
                }

                const messages =
                    event.messages || [];

                for (
                    const msg of messages
                ) {

                    await handleIncomingMessage(
                        msg
                    );
                }
            }
        );

        connectionState.reconnecting =
            false;

    } catch (error) {

        connectionState.reconnecting =
            false;

        connectionState.status =
            'error';

        connectionState.connected =
            false;

        connectionState.lastError =
            error.message;

        logger.error({
            error: error.message,
            stack: error.stack
        }, 'WhatsApp connection error');

        scheduleReconnect();
    }
}

/*
|--------------------------------------------------------------------------
| Reconnect
|--------------------------------------------------------------------------
*/

function scheduleReconnect() {

    if (
        connectionState.status ===
        'logged_out'
    ) {
        return;
    }

    if (reconnectTimer) {
        return;
    }

    reconnectAttempts++;

    const exponential =
        Math.min(
            reconnectAttempts,
            6
        );

    const wait =
        Math.min(
            60_000,
            2_000 *
            Math.pow(2, exponential - 1)
        );

    connectionState.reconnecting =
        true;

    logger.info({
        wait,
        reconnectAttempts
    }, 'Scheduling reconnect');

    reconnectTimer =
        setTimeout(
            async () => {

                reconnectTimer =
                    null;

                connectionState.reconnecting =
                    false;

                await connectWhatsApp();

            },
            wait
        );
}

/*
|--------------------------------------------------------------------------
| Phone number validation
|--------------------------------------------------------------------------
*/

function makeJid(value) {

    const number =
        normalizePhone(value);

    if (!number) {
        return null;
    }

    return `${number}@s.whatsapp.net`;
}

/*
|--------------------------------------------------------------------------
| SEND MESSAGE
|--------------------------------------------------------------------------
*/

async function sendText(
    number,
    text,
    options = {}
) {

    if (!sock) {

        throw new Error(
            'WHATSAPP_NOT_CONNECTED'
        );
    }

    if (
        connectionState.status !==
        'connected'
    ) {

        throw new Error(
            'WHATSAPP_NOT_CONNECTED'
        );
    }

    const cleanNumber =
        normalizePhone(number);

    if (!cleanNumber) {

        throw new Error(
            'INVALID_PHONE_NUMBER'
        );
    }

    if (
        !text ||
        !String(text).trim()
    ) {

        throw new Error(
            'EMPTY_MESSAGE'
        );
    }

    /*
     * Campaign safety.
     */
    if (options.campaign === true) {

        if (
            campaignPaused
        ) {

            throw new Error(
                'CAMPAIGN_PAUSED'
            );
        }

        const contact =
            ensureContact(
                cleanNumber
            );

        if (
            COMPLIANCE.REQUIRE_OPT_IN_FOR_CAMPAIGN &&
            !contact.optedIn
        ) {

            throw new Error(
                'RECIPIENT_NOT_OPTED_IN'
            );
        }

        if (contact.optedOut) {

            throw new Error(
                'RECIPIENT_OPTED_OUT'
            );
        }

        /*
         * If this is an official WhatsApp Business
         * Platform campaign, the caller must use the
         * approved template flow outside this connector.
         */
        if (
            options.businessInitiated === true &&
            !options.approvedTemplate
        ) {

            throw new Error(
                'APPROVED_TEMPLATE_REQUIRED'
            );
        }
    }

    /*
     * For automated customer-service responses,
     * keep the response inside the customer window.
     */
    if (
        options.automated === true &&
        !withinCustomerWindow(cleanNumber)
    ) {

        throw new Error(
            'CUSTOMER_SERVICE_WINDOW_EXPIRED'
        );
    }

    await waitForOutboundSlot();

    const jid =
        makeJid(cleanNumber);

    if (!jid) {
        throw new Error(
            'INVALID_PHONE_NUMBER'
        );
    }

    try {

        const result =
            await sock.sendMessage(
                jid,
                {
                    text:
                        String(text).trim()
                }
            );

        recordOutbound();

        const contact =
            ensureContact(
                cleanNumber
            );

        contact.lastOutboundAt =
            new Date().toISOString();

        contact.outboundCount++;

        saveContacts();

        return {
            success: true,
            messageId:
                result?.key?.id || null,
            to: cleanNumber
        };

    } catch (error) {

        recordOutboundError(
            error
        );

        throw error;
    }
}

/*
|--------------------------------------------------------------------------
| SEND MEDIA
|--------------------------------------------------------------------------
*/

async function sendMedia(
    number,
    media,
    caption = '',
    options = {}
) {

    if (!sock) {

        throw new Error(
            'WHATSAPP_NOT_CONNECTED'
        );
    }

    const cleanNumber =
        normalizePhone(number);

    if (!cleanNumber) {

        throw new Error(
            'INVALID_PHONE_NUMBER'
        );
    }

    if (
        options.campaign === true
    ) {

        const contact =
            ensureContact(
                cleanNumber
            );

        if (
            COMPLIANCE.REQUIRE_OPT_IN_FOR_CAMPAIGN &&
            !contact.optedIn
        ) {

            throw new Error(
                'RECIPIENT_NOT_OPTED_IN'
            );
        }

        if (contact.optedOut) {

            throw new Error(
                'RECIPIENT_OPTED_OUT'
            );
        }
    }

    if (
        options.automated === true &&
        !withinCustomerWindow(cleanNumber)
    ) {

        throw new Error(
            'CUSTOMER_SERVICE_WINDOW_EXPIRED'
        );
    }

    await waitForOutboundSlot();

    const jid =
        makeJid(cleanNumber);

    let message;

    /*
     * URL media.
     */
    if (
        typeof media === 'string' &&
        /^https?:\/\//i.test(media)
    ) {

        message = {
            image: {
                url: media
            }
        };

    } else if (
        typeof media === 'string' &&
        fs.existsSync(media)
    ) {

        message = {
            document: {
                url: media
            }
        };

    } else {

        throw new Error(
            'INVALID_MEDIA'
        );
    }

    if (caption) {
        message.caption =
            String(caption);
    }

    try {

        const result =
            await sock.sendMessage(
                jid,
                message
            );

        recordOutbound();

        return {
            success: true,
            messageId:
                result?.key?.id || null,
            to: cleanNumber
        };

    } catch (error) {

        recordOutboundError(
            error
        );

        throw error;
    }
}

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get(
    '/health',
    (req, res) => {

        res.json({

            success: true,

            name:
                'RBWA WhatsApp Connector',

            version:
                '5.0.0-compliance',

            status:
                connectionState.status,

            connected:
                connectionState.connected,

            phone:
                connectionState.phone,

            uptime:
                Math.floor(
                    process.uptime()
                ),

            qr_ttl_seconds:
                connectionState.qrExpiresAt
                    ? Math.max(
                        0,
                        Math.floor(
                            (
                                connectionState.qrExpiresAt -
                                Date.now()
                            ) / 1000
                        )
                    )
                    : 0,

            compliance: {

                ignoreGroups:
                    COMPLIANCE.IGNORE_GROUPS,

                ignoreFromMe:
                    COMPLIANCE.IGNORE_FROM_ME,

                customerWindowHours:
                    24,

                requireOptInForCampaign:
                    COMPLIANCE.REQUIRE_OPT_IN_FOR_CAMPAIGN,

                campaignPaused,

                hourlyOutbound:
                    hourlyOutboundCount(),

                hourlyLimit:
                    COMPLIANCE.MAX_OUTBOUND_PER_HOUR
            }

        });
    }
);

/*
|--------------------------------------------------------------------------
| STATUS
|--------------------------------------------------------------------------
*/

app.get(
    '/status',
    requireAuth,
    (req, res) => {

        res.json({

            success: true,

            ...connectionState,

            stats: {

                incoming:
                    incomingCount,

                outgoing:
                    outgoingCount,

                webhook:
                    webhookCount,

                contacts:
                    Object.keys(
                        contacts
                    ).length,

                hourlyOutbound:
                    hourlyOutboundCount(),

                consecutiveOutboundErrors,

                campaignPaused
            }
        });
    }
);

/*
|--------------------------------------------------------------------------
| QR
|--------------------------------------------------------------------------
*/

app.get(
    '/qr',
    requireAuth,
    (req, res) => {

        if (!connectionState.qr) {

            return res.json({

                success: false,

                connected:
                    connectionState.connected,

                status:
                    connectionState.status,

                message:
                    'QR code not available'
            });
        }

        res.json({

            success: true,

            qr:
                connectionState.qr,

            expiresAt:
                connectionState.qrExpiresAt
        });
    }
);

/*
|--------------------------------------------------------------------------
| QR IMAGE
|--------------------------------------------------------------------------
*/

app.get(
    '/qr-image',
    requireAuth,
    (req, res) => {

        if (
            !fs.existsSync(QR_FILE)
        ) {

            return res.status(404).json({

                success: false,

                error: {
                    code:
                        'QR_NOT_AVAILABLE',

                    message:
                        'QR image not available'
                }
            });
        }

        res.setHeader(
            'Content-Type',
            'image/png'
        );

        res.sendFile(
            QR_FILE
        );
    }
);

/*
|--------------------------------------------------------------------------
| CONNECT
|--------------------------------------------------------------------------
*/

app.post(
    '/connect',
    requireAuth,
    async (req, res) => {

        try {

            if (
                connectionState.connected
            ) {

                return res.json({

                    success: true,

                    status:
                        'connected',

                    message:
                        'Already connected'
                });
            }

            await connectWhatsApp();

            res.json({

                success: true,

                status:
                    connectionState.status,

                message:
                    'Connection started'
            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error: {
                    code:
                        'CONNECT_FAILED',

                    message:
                        error.message
                }
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| PAIR
|--------------------------------------------------------------------------
*/

app.post(
    '/pair',
    requireAuth,
    async (req, res) => {

        try {

            const phone =
                normalizePhone(
                    req.body.phone ||
                    req.body.number ||
                    req.body.to
                );

            if (!phone) {

                return res.status(400).json({

                    success: false,

                    error: {
                        code:
                            'INVALID_PHONE',

                        message:
                            'Phone number is required'
                    }
                });
            }

            if (!sock) {

                await connectWhatsApp();
            }

            if (
                !sock ||
                typeof sock.requestPairingCode !==
                'function'
            ) {

                return res.status(503).json({

                    success: false,

                    error: {
                        code:
                            'PAIRING_UNAVAILABLE',

                        message:
                            'Pairing is not currently available'
                    }
                });
            }

            const code =
                await sock.requestPairingCode(
                    phone
                );

            res.json({

                success: true,

                phone,

                code,

                message:
                    'Enter this pairing code in WhatsApp'
            });

        } catch (error) {

            logger.error({
                error: error.message
            }, 'Pairing failed');

            res.status(500).json({

                success: false,

                error: {
                    code:
                        'PAIR_FAILED',

                    message:
                        error.message
                }
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| DISCONNECT
|--------------------------------------------------------------------------
*/

app.post(
    '/disconnect',
    requireAuth,
    async (req, res) => {

        try {

            if (sock) {

                try {
                    await sock.logout();
                } catch {}
            }

            sock = null;

            clearQR();

            connectionState = {

                status:
                    'logged_out',

                connected:
                    false,

                qr: null,

                qrExpiresAt: 0,

                phone: null,

                name: null,

                lastError: null,

                reconnecting:
                    false
            };

            res.json({

                success: true,

                status:
                    'logged_out'
            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error: {
                    code:
                        'DISCONNECT_FAILED',

                    message:
                        error.message
                }
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| RESET
|--------------------------------------------------------------------------
*/

app.post(
    '/reset',
    requireAuth,
    async (req, res) => {

        try {

            if (sock) {

                try {
                    await sock.logout();
                } catch {}
            }

            sock = null;

            clearQR();

            /*
             * Remove authentication state.
             */
            if (
                fs.existsSync(AUTH_DIR)
            ) {

                fs.rmSync(
                    AUTH_DIR,
                    {
                        recursive: true,
                        force: true
                    }
                );
            }

            fs.mkdirSync(
                AUTH_DIR,
                {
                    recursive: true
                }
            );

            connectionState = {

                status:
                    'disconnected',

                connected:
                    false,

                qr: null,

                qrExpiresAt: 0,

                phone: null,

                name: null,

                lastError: null,

                reconnecting:
                    false
            };

            reconnectAttempts = 0;

            campaignPaused = false;

            res.json({

                success: true,

                status:
                    'reset',

                message:
                    'Authentication reset. Connect again for a new QR code.'
            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error: {
                    code:
                        'RESET_FAILED',

                    message:
                        error.message
                }
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| SEND MESSAGE
|--------------------------------------------------------------------------
*/

app.post(
    '/send-message',
    requireAuth,
    async (req, res) => {

        try {

            const number =
                req.body.number ||
                req.body.to ||
                req.body.phone;

            const message =
                req.body.message ||
                req.body.text ||
                req.body.body;

            /*
             * Supported flags:
             *
             * campaign=true
             * automated=true
             * businessInitiated=true
             * approvedTemplate=true
             */
            const options = {

                campaign:
                    req.body.campaign === true ||
                    req.body.campaign === 'true',

                automated:
                    req.body.automated === true ||
                    req.body.automated === 'true',

                businessInitiated:
                    req.body.businessInitiated === true ||
                    req.body.businessInitiated === 'true',

                approvedTemplate:
                    req.body.approvedTemplate === true ||
                    req.body.approvedTemplate === 'true'
            };

            const result =
                await sendText(
                    number,
                    message,
                    options
                );

            res.json(result);

        } catch (error) {

            const code =
                error.message ||
                'SEND_FAILED';

            let status = 400;

            if (
                code ===
                'WHATSAPP_NOT_CONNECTED'
            ) {
                status = 503;
            }

            res.status(status).json({

                success: false,

                error: {
                    code,
                    message: code
                }
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
    '/send-media',
    requireAuth,
    async (req, res) => {

        try {

            const result =
                await sendMedia(

                    req.body.number ||
                    req.body.to ||
                    req.body.phone,

                    req.body.url ||
                    req.body.media,

                    req.body.caption ||
                    '',

                    {
                        campaign:
                            req.body.campaign === true ||
                            req.body.campaign === 'true',

                        automated:
                            req.body.automated === true ||
                            req.body.automated === 'true'
                    }
                );

            res.json(result);

        } catch (error) {

            res.status(400).json({

                success: false,

                error: {
                    code:
                        error.message ||
                        'MEDIA_SEND_FAILED',

                    message:
                        error.message
                }
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| OPT-IN
|--------------------------------------------------------------------------
*/

app.post(
    '/opt-in',
    requireAuth,
    (req, res) => {

        const number =
            req.body.number ||
            req.body.phone;

        if (
            !number
        ) {

            return res.status(400).json({

                success: false,

                error: {
                    code:
                        'INVALID_PHONE',

                    message:
                        'Phone number is required'
                }
            });
        }

        const ok =
            applyOptIn(
                number,
                req.body.source ||
                'admin'
            );

        res.json({
            success: ok,
            number:
                normalizePhone(number)
        });
    }
);

/*
|--------------------------------------------------------------------------
| OPT-OUT
|--------------------------------------------------------------------------
*/

app.post(
    '/opt-out',
    requireAuth,
    (req, res) => {

        const number =
            req.body.number ||
            req.body.phone;

        if (
            !number
        ) {

            return res.status(400).json({

                success: false,

                error: {
                    code:
                        'INVALID_PHONE',

                    message:
                        'Phone number is required'
                }
            });
        }

        const ok =
            applyOptOut(
                number,
                req.body.source ||
                'admin'
            );

        res.json({
            success: ok,
            number:
                normalizePhone(number)
        });
    }
);

/*
|--------------------------------------------------------------------------
| CONTACT STATUS
|--------------------------------------------------------------------------
*/

app.get(
    '/contact/:number',
    requireAuth,
    (req, res) => {

        const number =
            normalizePhone(
                req.params.number
            );

        const contact =
            number
                ? contacts[number]
                : null;

        if (!contact) {

            return res.status(404).json({

                success: false,

                error: {
                    code:
                        'CONTACT_NOT_FOUND',

                    message:
                        'Contact not found'
                }
            });
        }

        res.json({

            success: true,

            contact: {

                ...contact,

                customerWindow:
                    withinCustomerWindow(
                        number
                    )
            }
        });
    }
);

/*
|--------------------------------------------------------------------------
| CAMPAIGN STATUS
|--------------------------------------------------------------------------
*/

app.get(
    '/campaign/status',
    requireAuth,
    (req, res) => {

        res.json({

            success: true,

            paused:
                campaignPaused,

            hourlyOutbound:
                hourlyOutboundCount(),

            hourlyLimit:
                COMPLIANCE.MAX_OUTBOUND_PER_HOUR,

            consecutiveErrors:
                consecutiveOutboundErrors,

            maxConsecutiveErrors:
                COMPLIANCE.MAX_CONSECUTIVE_ERRORS
        });
    }
);

/*
|--------------------------------------------------------------------------
| RESUME CAMPAIGN
|--------------------------------------------------------------------------
*/

app.post(
    '/campaign/resume',
    requireAuth,
    (req, res) => {

        /*
         * Only allow manual resume.
         * This prevents an automatic loop after failures.
         */
        campaignPaused = false;

        consecutiveOutboundErrors = 0;

        res.json({

            success: true,

            paused:
                false
        });
    }
);

/*
|--------------------------------------------------------------------------
| PAUSE CAMPAIGN
|--------------------------------------------------------------------------
*/

app.post(
    '/campaign/pause',
    requireAuth,
    (req, res) => {

        campaignPaused = true;

        res.json({

            success: true,

            paused:
                true
        });
    }
);

/*
|--------------------------------------------------------------------------
| CONTACTS / OPT-IN STATS
|--------------------------------------------------------------------------
*/

app.get(
    '/compliance/stats',
    requireAuth,
    (req, res) => {

        const list =
            Object.values(
                contacts
            );

        const optedIn =
            list.filter(
                item =>
                    item.optedIn &&
                    !item.optedOut
            ).length;

        const optedOut =
            list.filter(
                item =>
                    item.optedOut
            ).length;

        const withinWindow =
            list.filter(
                item =>
                    withinCustomerWindow(
                        item.number
                    )
            ).length;

        res.json({

            success: true,

            contacts:
                list.length,

            optedIn,

            optedOut,

            customerWindowOpen:
                withinWindow,

            customerWindowHours:
                24,

            campaignPaused,

            outboundLastHour:
                hourlyOutboundCount()
        });
    }
);

/*
|--------------------------------------------------------------------------
| ROOT
|--------------------------------------------------------------------------
*/

app.get(
    '/',
    (req, res) => {

        res.json({

            success: true,

            name:
                'RBWA WhatsApp Connector',

            version:
                '5.0.0-compliance',

            status:
                connectionState.status,

            endpoints: [

                'GET /health',

                'GET /status',

                'GET /qr',

                'GET /qr-image',

                'POST /connect',

                'POST /pair',

                'POST /disconnect',

                'POST /reset',

                'POST /send-message',

                'POST /send-media',

                'POST /opt-in',

                'POST /opt-out',

                'GET /contact/:number',

                'GET /campaign/status',

                'POST /campaign/pause',

                'POST /campaign/resume',

                'GET /compliance/stats'
            ]
        });
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

            error: {
                code:
                    'NOT_FOUND',

                message:
                    'Endpoint not found'
            }
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

        logger.error({
            error:
                error.message
        }, 'Express error');

        res.status(500).json({

            success: false,

            error: {
                code:
                    'SERVER_ERROR',

                message:
                    error.message
            }
        });
    }
);

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        logger.info({
            port: PORT
        }, 'RBWA connector started');

        logger.info({
            requireOptIn:
                COMPLIANCE.REQUIRE_OPT_IN_FOR_CAMPAIGN,

            ignoreGroups:
                COMPLIANCE.IGNORE_GROUPS,

            ignoreFromMe:
                COMPLIANCE.IGNORE_FROM_ME,

            minOutboundDelay:
                COMPLIANCE.MIN_OUTBOUND_DELAY_MS,

            hourlyLimit:
                COMPLIANCE.MAX_OUTBOUND_PER_HOUR
        }, 'Compliance configuration');

        /*
         * Automatically start the WhatsApp connection.
         */
        connectWhatsApp()
            .catch(error => {

                logger.error({
                    error: error.message
                }, 'Initial connection failed');
            });
    }
);

/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
*/

async function shutdown(signal) {

    logger.info({
        signal
    }, 'Shutdown requested');

    try {

        if (sock) {
            sock.end(
                undefined
            );
        }

    } catch {}

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

/*
|--------------------------------------------------------------------------
| Prevent unhandled crashes
|--------------------------------------------------------------------------
*/

process.on(
    'unhandledRejection',
    error => {

        logger.error({
            error:
                error?.message ||
                String(error)
        }, 'Unhandled rejection');
    }
);

process.on(
    'uncaughtException',
    error => {

        logger.error({
            error:
                error.message,
            stack:
                error.stack
        }, 'Uncaught exception');
    }
);
