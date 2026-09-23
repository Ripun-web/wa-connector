'use strict';

/*
 * ============================================================
 * RB WhatsApp Connector
 * Version: 3.0.0
 *
 * Compatible API:
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
 *
 * POST /send-message
 * POST /send-media
 *
 * Environment:
 *
 * PORT=3000
 * DEFAULT_COUNTRY=IN
 * API_TOKEN=
 * AUTH_DIR=./auth_info
 *
 * QR lifetime: 5 minutes
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');

const {
    parsePhoneNumberFromString,
    getCountryCallingCode
} = require('libphonenumber-js');


/* ============================================================
 * CONFIG
 * ============================================================
 */

const PORT = Number(process.env.PORT || 3000);

const DEFAULT_COUNTRY = (
    process.env.DEFAULT_COUNTRY || 'IN'
).toUpperCase();

const API_TOKEN = process.env.API_TOKEN || '';

const AUTH_DIR = path.resolve(
    process.env.AUTH_DIR || './auth_info'
);

const QR_TTL = 5 * 60 * 1000;

const CONNECT_TIMEOUT = 45 * 1000;

const PAIRING_TIMEOUT = 60 * 1000;

const RECONNECT_BASE = 2000;

const RECONNECT_MAX = 30000;

const MAX_RECONNECTS = 12;


/* ============================================================
 * DIRECTORIES
 * ============================================================
 */

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, {
        recursive: true
    });
}


/* ============================================================
 * LOGGER
 * ============================================================
 */

const logger = pino({
    level: process.env.LOG_LEVEL || 'info'
});


/* ============================================================
 * EXPRESS
 * ============================================================
 */

const app = express();

app.disable('x-powered-by');

app.use(cors());

app.use(express.json({
    limit: '25mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '25mb'
}));


/* ============================================================
 * GLOBAL STATE
 * ============================================================
 */

let sock = null;

let authState = null;

let saveCreds = null;

let socketGeneration = 0;

let reconnectTimer = null;

let qrTimer = null;

let connectWatchdog = null;

let pairingWatchdog = null;

let reconnectAttempts = 0;

let starting = false;

let stopRequested = false;

let desiredMode = null;

let pairingPhone = null;

let pairingCode = null;

let currentQR = null;

let qrImage = null;

let qrCreatedAt = null;

let qrExpiresAt = null;

let connectedAt = null;

let phone = null;

let pushName = null;

let lastError = null;

let lastDisconnect = null;

let connectionStatus = 'disconnected';


/* ============================================================
 * UTILS
 * ============================================================
 */

function nowISO() {
    return new Date().toISOString();
}


function log(...args) {
    logger.info(...args);
}


function warn(...args) {
    logger.warn(...args);
}


function errorLog(...args) {
    logger.error(...args);
}


function clearTimer(timer) {
    if (timer) {
        clearTimeout(timer);
    }
    return null;
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/* ============================================================
 * PHONE NUMBER NORMALIZATION
 * ============================================================
 *
 * Examples:
 *
 * 9876543210
 * +91 9876543210
 * 0091 9876543210
 * 91-9876543210
 *
 * Result:
 *
 * 919876543210
 *
 * Pairing code requires international digits-only number.
 * ============================================================
 */

function normalizePhoneNumber(input, defaultCountry = DEFAULT_COUNTRY) {

    if (input === undefined || input === null) {
        throw new Error('Phone number is required');
    }

    let raw = String(input).trim();

    if (!raw) {
        throw new Error('Phone number is empty');
    }

    raw = raw.replace(/[()\-\s.]/g, '');

    /*
     * Convert 00XXXXXXXX to +XXXXXXXX
     */
    if (raw.startsWith('00')) {
        raw = '+' + raw.substring(2);
    }

    /*
     * Already international.
     */
    if (raw.startsWith('+')) {

        const parsed = parsePhoneNumberFromString(raw);

        if (!parsed || !parsed.isPossible()) {
            throw new Error(
                'Invalid international phone number'
            );
        }

        return {
            e164: parsed.number,
            digits: parsed.number.replace(/\D/g, ''),
            country: parsed.country || null,
            callingCode: parsed.countryCallingCode,
            nationalNumber: parsed.nationalNumber
        };
    }

    /*
     * Digits only from here.
     */
    const digits = raw.replace(/\D/g, '');

    if (!digits) {
        throw new Error('Invalid phone number');
    }

    /*
     * Try supplied/default country first.
     *
     * For example:
     * 9876543210 + IN => +919876543210
     */
    let parsed = parsePhoneNumberFromString(
        digits,
        defaultCountry
    );

    /*
     * If that didn't work, try treating it as
     * an already international number.
     */
    if (!parsed) {
        parsed = parsePhoneNumberFromString(
            '+' + digits
        );
    }

    if (!parsed || !parsed.isPossible()) {
        throw new Error(
            `Could not determine a valid international phone number. ` +
            `Use +countrycode + number, e.g. +919876543210`
        );
    }

    return {
        e164: parsed.number,
        digits: parsed.number.replace(/\D/g, ''),
        country: parsed.country || null,
        callingCode: parsed.countryCallingCode,
        nationalNumber: parsed.nationalNumber
    };
}


/* ============================================================
 * PHONE VALIDATION
 * ============================================================
 */

function getPhoneInfo(input) {

    const result = normalizePhoneNumber(
        input,
        DEFAULT_COUNTRY
    );

    return {
        success: true,
        input: String(input),
        international: result.e164,
        digits: result.digits,
        country: result.country,
        country_calling_code: result.callingCode,
        national_number: result.nationalNumber
    };
}


/* ============================================================
 * SOCKET STATE
 * ============================================================
 */

function setStatus(status) {

    connectionStatus = status;

    log(
        `[STATUS] ${status}`
    );
}


/* ============================================================
 * CLEAR QR
 * ============================================================
 */

function clearQR() {

    currentQR = null;
    qrImage = null;
    qrCreatedAt = null;
    qrExpiresAt = null;

    qrTimer = clearTimer(qrTimer);
}


/* ============================================================
 * CREATE QR IMAGE
 * ============================================================
 */

async function createQR(qr) {

    currentQR = qr;

    qrCreatedAt = Date.now();

    qrExpiresAt =
        qrCreatedAt + QR_TTL;

    try {

        qrImage = await QRCode.toDataURL(
            qr,
            {
                errorCorrectionLevel: 'M',
                margin: 2,
                width: 480
            }
        );

    } catch (err) {

        qrImage = null;

        errorLog(
            'QR image generation failed:',
            err.message
        );
    }

    /*
     * Exactly 5 minutes.
     */
    qrTimer = clearTimer(qrTimer);

    qrTimer = setTimeout(async () => {

        /*
         * Only expire if this is still
         * the current QR.
         */
        if (
            currentQR === qr &&
            connectionStatus !== 'connected'
        ) {

            log(
                '[QR] 5 minute QR expired'
            );

            clearQR();

            /*
             * Automatically generate a fresh QR.
             */
            if (
                !stopRequested &&
                desiredMode === 'qr'
            ) {

                try {

                    await restartSocket(
                        'QR expired'
                    );

                } catch (err) {

                    errorLog(
                        'QR refresh failed:',
                        err.message
                    );
                }
            }
        }

    }, QR_TTL + 250);

    log(
        '[QR] New QR generated, expires in 5 minutes'
    );
}


/* ============================================================
 * DISCONNECT REASON
 * ============================================================
 */

function getDisconnectCode(lastDisconnect) {

    try {

        if (!lastDisconnect) {
            return null;
        }

        const err =
            lastDisconnect.error;

        if (!err) {
            return null;
        }

        if (
            err instanceof Boom &&
            err.output &&
            err.output.statusCode
        ) {
            return err.output.statusCode;
        }

        if (
            err.output &&
            err.output.statusCode
        ) {
            return err.output.statusCode;
        }

        if (
            err.data &&
            err.data.statusCode
        ) {
            return err.data.statusCode;
        }

        if (err.statusCode) {
            return err.statusCode;
        }

        return null;

    } catch {
        return null;
    }
}


/* ============================================================
 * HUMAN DISCONNECT ERROR
 * ============================================================
 */

function explainDisconnect(code) {

    switch (Number(code)) {

        case DisconnectReason.loggedOut:
            return 'WhatsApp session logged out. Reset and pair again.';

        case DisconnectReason.badSession:
            return 'WhatsApp authentication session is invalid. Reset and pair again.';

        case DisconnectReason.connectionClosed:
            return 'WhatsApp connection closed.';

        case DisconnectReason.connectionLost:
            return 'WhatsApp connection lost.';

        case DisconnectReason.connectionReplaced:
            return 'This WhatsApp session was replaced by another device.';

        case DisconnectReason.timedOut:
            return 'WhatsApp connection timed out.';

        case DisconnectReason.restartRequired:
            return 'WhatsApp requested a connection restart.';

        case DisconnectReason.multideviceMismatch:
            return 'WhatsApp multi-device mismatch.';

        case DisconnectReason.forbidden:
            return 'WhatsApp rejected the connection.';

        default:
            return code
                ? `WhatsApp disconnected with code ${code}.`
                : 'WhatsApp connection closed.';
    }
}


/* ============================================================
 * CLEAR WATCHDOGS
 * ============================================================
 */

function clearWatchdogs() {

    connectWatchdog =
        clearTimer(connectWatchdog);

    pairingWatchdog =
        clearTimer(pairingWatchdog);
}


/* ============================================================
 * SAFE SOCKET END
 * ============================================================
 */

async function closeSocket() {

    const old = sock;

    sock = null;

    if (!old) {
        return;
    }

    try {

        old.ev.removeAllListeners();

    } catch {}

    try {

        if (old.ws && old.ws.close) {
            old.ws.close();
        }

    } catch {}

    try {

        if (old.end) {
            old.end(
                new Error('Socket restart')
            );
        }

    } catch {}
}


/* ============================================================
 * CANCEL RECONNECT
 * ============================================================
 */

function cancelReconnect() {

    reconnectTimer =
        clearTimer(reconnectTimer);
}


/* ============================================================
 * SCHEDULE RECONNECT
 * ============================================================
 */

function scheduleReconnect(reason) {

    if (stopRequested) {
        return;
    }

    if (desiredMode === null) {
        return;
    }

    if (reconnectTimer) {
        return;
    }

    reconnectAttempts++;

    if (
        reconnectAttempts > MAX_RECONNECTS
    ) {

        /*
         * Do NOT leave the connector permanently
         * stuck in "Max reconnect attempts reached".
         *
         * Wait longer, then start fresh.
         */
        reconnectAttempts = 0;

        warn(
            '[RECONNECT] Restarting reconnect cycle:',
            reason
        );
    }

    const exponent =
        Math.min(
            reconnectAttempts - 1,
            5
        );

    const delay =
        Math.min(
            RECONNECT_BASE *
            Math.pow(2, exponent),
            RECONNECT_MAX
        );

    log(
        `[RECONNECT] ${delay}ms - ${reason}`
    );

    reconnectTimer =
        setTimeout(async () => {

            reconnectTimer = null;

            if (stopRequested) {
                return;
            }

            try {

                await startSocket(
                    desiredMode,
                    pairingPhone
                );

            } catch (err) {

                errorLog(
                    '[RECONNECT] Failed:',
                    err.message
                );

                scheduleReconnect(
                    err.message
                );
            }

        }, delay);
}


/* ============================================================
 * WAIT FOR CONNECTION
 * ============================================================
 */

function waitForConnection(
    generation,
    timeout = CONNECT_TIMEOUT
) {

    return new Promise((resolve, reject) => {

        const started = Date.now();

        const timer =
            setInterval(() => {

                if (
                    generation !== socketGeneration
                ) {

                    clearInterval(timer);

                    reject(
                        new Error(
                            'Socket was replaced'
                        )
                    );

                    return;
                }

                if (
                    connectionStatus ===
                    'connected'
                ) {

                    clearInterval(timer);

                    resolve(true);

                    return;
                }

                if (
                    connectionStatus ===
                    'error'
                ) {

                    clearInterval(timer);

                    reject(
                        new Error(
                            lastError ||
                            'Connection failed'
                        )
                    );

                    return;
                }

                if (
                    Date.now() - started >=
                    timeout
                ) {

                    clearInterval(timer);

                    reject(
                        new Error(
                            'Connection timeout'
                        )
                    );

                }

            }, 250);

    });
}


/* ============================================================
 * START SOCKET
 * ============================================================
 */

async function startSocket(
    mode = 'qr',
    requestedPhone = null
) {

    if (starting) {

        log(
            '[SOCKET] Start already in progress'
        );

        return;
    }

    starting = true;

    stopRequested = false;

    desiredMode = mode;

    clearWatchdogs();

    cancelReconnect();

    const generation =
        ++socketGeneration;

    try {

        /*
         * Close previous socket first.
         */
        await closeSocket();

        /*
         * Load authentication state.
         */
        const auth =
            await useMultiFileAuthState(
                AUTH_DIR
            );

        authState = auth.state;
        saveCreds = auth.saveCreds;

        /*
         * QR and pairing are mutually exclusive.
         */
        const pairingMode =
            mode === 'pair';

        if (pairingMode) {

            clearQR();

            pairingCode = null;

            if (!requestedPhone) {

                throw new Error(
                    'Phone number is required for pairing'
                );
            }

            const phoneInfo =
                normalizePhoneNumber(
                    requestedPhone
                );

            pairingPhone =
                phoneInfo.digits;

            log(
                '[PAIR] Number:',
                phoneInfo.e164,
                '| Country:',
                phoneInfo.country || 'unknown'
            );
        }

        /*
         * New socket.
         */
        const newSock =
            makeWASocket({

                auth: authState,

                browser:
                    Browsers.ubuntu(
                        'RB WhatsApp Connector'
                    ),

                printQRInTerminal: false,

                /*
                 * Keep WhatsApp online status
                 * behavior predictable.
                 */
                markOnlineOnConnect: false,

                /*
                 * Avoid full history overhead.
                 */
                syncFullHistory: false,

                /*
                 * Keep logger quiet.
                 */
                logger: pino({
                    level: 'silent'
                }),

                /*
                 * Connection settings.
                 */
                connectTimeoutMs:
                    CONNECT_TIMEOUT,

                defaultQueryTimeoutMs:
                    60000,

                keepAliveIntervalMs:
                    25000
            });

        sock = newSock;

        setStatus(
            pairingMode
                ? 'pairing'
                : 'connecting'
        );

        lastError = null;

        lastDisconnect = null;

        /*
         * Save credentials.
         */
        newSock.ev.on(
            'creds.update',
            async creds => {

                try {

                    await saveCreds(
                        creds
                    );

                } catch (err) {

                    errorLog(
                        '[AUTH] Save creds failed:',
                        err.message
                    );
                }
            }
        );


        /* ====================================================
         * CONNECTION EVENTS
         * ====================================================
         */

        newSock.ev.on(
            'connection.update',
            async update => {

                /*
                 * Ignore stale socket.
                 */
                if (
                    generation !== socketGeneration ||
                    sock !== newSock
                ) {
                    return;
                }

                const {
                    connection,
                    lastDisconnect: ld,
                    qr
                } = update;


                /*
                 * QR
                 */
                if (
                    qr &&
                    !pairingMode &&
                    !stopRequested
                ) {

                    try {

                        await createQR(
                            qr
                        );

                        setStatus(
                            'qr'
                        );

                    } catch (err) {

                        lastError =
                            err.message;

                        errorLog(
                            '[QR]',
                            err.message
                        );
                    }
                }


                /*
                 * Connection opening.
                 */
                if (
                    connection ===
                    'connecting'
                ) {

                    setStatus(
                        pairingMode
                            ? 'pairing'
                            : currentQR
                                ? 'qr'
                                : 'connecting'
                    );

                    /*
                     * Pairing code should be requested
                     * only after the socket has actually
                     * entered the connection lifecycle.
                     */
                    if (
                        pairingMode &&
                        !pairingCode &&
                        !authState.creds.registered
                    ) {

                        try {

                            const code =
                                await newSock
                                    .requestPairingCode(
                                        pairingPhone
                                    );

                            if (
                                generation !==
                                socketGeneration
                            ) {
                                return;
                            }

                            pairingCode =
                                String(code)
                                    .replace(
                                        /[^A-Z0-9]/gi,
                                        ''
                                    )
                                    .toUpperCase();

                            /*
                             * Display as XXXX-XXXX.
                             */
                            if (
                                pairingCode.length === 8
                            ) {

                                pairingCode =
                                    pairingCode.slice(
                                        0,
                                        4
                                    ) +
                                    '-' +
                                    pairingCode.slice(
                                        4
                                    );
                            }

                            log(
                                '[PAIR] Pairing code:',
                                pairingCode
                            );

                            /*
                             * Don't immediately destroy
                             * the socket. Give WhatsApp time
                             * to complete the pairing.
                             */
                            pairingWatchdog =
                                clearTimer(
                                    pairingWatchdog
                                );

                            pairingWatchdog =
                                setTimeout(() => {

                                    if (
                                        connectionStatus !==
                                        'connected'
                                    ) {

                                        lastError =
                                            'Pairing timed out. Please generate a new pairing code.';

                                        warn(
                                            '[PAIR] Pairing timeout'
                                        );

                                        restartSocket(
                                            'Pairing timeout'
                                        ).catch(
                                            errorLog
                                        );
                                    }

                                }, PAIRING_TIMEOUT);

                        } catch (err) {

                            lastError =
                                err.message;

                            errorLog(
                                '[PAIR] Code request failed:',
                                err.message
                            );

                            setStatus(
                                'error'
                            );

                            /*
                             * Retry with a completely
                             * fresh socket.
                             */
                            setTimeout(() => {

                                if (
                                    !stopRequested &&
                                    generation ===
                                    socketGeneration
                                ) {

                                    restartSocket(
                                        'Pairing code request failed'
                                    ).catch(
                                        errorLog
                                    );
                                }

                            }, 1500);
                        }
                    }
                }


                /*
                 * Connection opened.
                 */
                if (
                    connection ===
                    'open'
                ) {

                    if (
                        generation !==
                        socketGeneration
                    ) {
                        return;
                    }

                    clearWatchdogs();

                    cancelReconnect();

                    reconnectAttempts = 0;

                    clearQR();

                    pairingCode = null;

                    connectedAt =
                        connectedAt ||
                        nowISO();

                    lastError = null;

                    connectionStatus =
                        'connected';

                    /*
                     * Get logged-in number.
                     */
                    try {

                        const jid =
                            newSock.user?.id;

                        if (jid) {

                            phone =
                                jid.split(':')[0]
                                    .split('@')[0];
                        }

                        pushName =
                            newSock.user?.name ||
                            null;

                    } catch {}

                    log(
                        '[CONNECTED]',
                        phone || 'unknown'
                    );
                }


                /*
                 * Connection closed.
                 */
                if (
                    connection ===
                    'close'
                ) {

                    clearWatchdogs();

                    clearQR();

                    const code =
                        getDisconnectCode(
                            ld
                        );

                    lastDisconnect =
                        code;

                    const reason =
                        explainDisconnect(
                            code
                        );

                    errorLog(
                        '[CLOSED]',
                        reason
                    );

                    /*
                     * Logged out / bad session:
                     * don't endlessly reconnect.
                     */
                    if (
                        code ===
                        DisconnectReason.loggedOut ||
                        code ===
                        DisconnectReason.badSession
                    ) {

                        connectionStatus =
                            'error';

                        lastError =
                            reason;

                        desiredMode =
                            null;

                        pairingCode =
                            null;

                        return;
                    }


                    /*
                     * Connection replaced.
                     */
                    if (
                        code ===
                        DisconnectReason.connectionReplaced
                    ) {

                        connectionStatus =
                            'error';

                        lastError =
                            reason;

                        desiredMode =
                            null;

                        return;
                    }


                    /*
                     * Normal temporary failure.
                     */
                    connectionStatus =
                        'connecting';

                    lastError =
                        reason;

                    scheduleReconnect(
                        reason
                    );
                }
            }
        );


        /*
         * Messages.
         *
         * Kept here so connector can receive messages
         * without breaking.
         */
        newSock.ev.on(
            'messages.upsert',
            ({ messages }) => {

                if (
                    generation !== socketGeneration
                ) {
                    return;
                }

                /*
                 * You can add webhook processing here
                 * later without changing the connector.
                 */
            }
        );


        /*
         * Watchdog for socket that remains connecting.
         */
        connectWatchdog =
            setTimeout(() => {

                if (
                    generation !== socketGeneration
                ) {
                    return;
                }

                if (
                    connectionStatus !==
                    'connected'
                ) {

                    lastError =
                        'Connection watchdog timeout';

                    warn(
                        '[WATCHDOG] Restarting socket'
                    );

                    restartSocket(
                        'Connection watchdog timeout'
                    ).catch(
                        errorLog
                    );
                }

            }, CONNECT_TIMEOUT + 10000);


        /*
         * Pairing mode:
         *
         * Wait a tiny moment for the socket to
         * initialize its WebSocket transport.
         *
         * The actual request is also guarded inside
         * connection.update.
         */
        if (
            pairingMode &&
            !authState.creds.registered
        ) {

            await sleep(500);

            if (
                generation === socketGeneration &&
                sock === newSock &&
                !pairingCode
            ) {

                try {

                    const code =
                        await newSock
                            .requestPairingCode(
                                pairingPhone
                            );

                    if (
                        generation !==
                        socketGeneration
                    ) {
                        return;
                    }

                    pairingCode =
                        String(code)
                            .replace(
                                /[^A-Z0-9]/gi,
                                ''
                            )
                            .toUpperCase();

                    if (
                        pairingCode.length === 8
                    ) {

                        pairingCode =
                            pairingCode.slice(
                                0,
                                4
                            ) +
                            '-' +
                            pairingCode.slice(
                                4
                            );
                    }

                    log(
                        '[PAIR] Code:',
                        pairingCode
                    );

                } catch (err) {

                    /*
                     * connection.update may already have
                     * requested it. Ignore duplicate error
                     * if code appeared.
                     */
                    if (!pairingCode) {

                        lastError =
                            err.message;

                        warn(
                            '[PAIR] Initial request failed:',
                            err.message
                        );
                    }
                }
            }
        }

    } catch (err) {

        lastError =
            err.message;

        setStatus(
            'error'
        );

        errorLog(
            '[START]',
            err
        );

        scheduleReconnect(
            err.message
        );

    } finally {

        starting = false;
    }
}


/* ============================================================
 * RESTART SOCKET
 * ============================================================
 */

async function restartSocket(reason) {

    if (starting) {
        return;
    }

    log(
        '[RESTART]',
        reason
    );

    const mode =
        desiredMode || 'qr';

    const number =
        pairingPhone;

    clearWatchdogs();

    cancelReconnect();

    clearQR();

    pairingCode = null;

    connectionStatus =
        'connecting';

    await closeSocket();

    /*
     * Small delay prevents old socket's close event
     * from racing the new socket.
     */
    await sleep(500);

    if (stopRequested) {
        return;
    }

    await startSocket(
        mode,
        number
    );
}


/* ============================================================
 * AUTH MIDDLEWARE
 * ============================================================
 */

function authMiddleware(req, res, next) {

    if (!API_TOKEN) {
        return next();
    }

    /*
     * Allow health/status/qr for the PHP panel
     * if no token is configured.
     *
     * If API_TOKEN is configured, all API routes
     * require it.
     */

    const supplied =
        req.headers['x-api-key'] ||
        req.headers['x-api-token'] ||
        (
            req.headers.authorization || ''
        ).replace(
            /^Bearer\s+/i,
            ''
        );

    if (
        supplied !== API_TOKEN
    ) {

        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }

    next();
}


app.use(authMiddleware);


/* ============================================================
 * ROOT
 * ============================================================
 */

app.get('/', (req, res) => {

    res.json({
        success: true,
        name: 'RB WhatsApp Connector',
        version: '3.0.0',
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        uptime: process.uptime(),
        qr_ttl_seconds: 300,
        default_country: DEFAULT_COUNTRY
    });
});


/* ============================================================
 * HEALTH
 * ============================================================
 */

app.get('/health', (req, res) => {

    res.json({
        success: true,
        healthy: true,
        status: connectionStatus,
        connected:
            connectionStatus === 'connected',
        uptime: process.uptime(),
        timestamp: nowISO()
    });
});


/* ============================================================
 * STATUS
 * ============================================================
 */

app.get('/status', (req, res) => {

    res.json({

        success: true,

        status:
            connectionStatus,

        connected:
            connectionStatus ===
            'connected',

        phone:
            phone || null,

        name:
            pushName || null,

        connected_at:
            connectedAt || null,

        qr_available:
            !!currentQR &&
            !!qrImage &&
            !!qrExpiresAt &&
            Date.now() < qrExpiresAt,

        qr_created_at:
            qrCreatedAt
                ? new Date(
                    qrCreatedAt
                ).toISOString()
                : null,

        qr_expires_at:
            qrExpiresAt
                ? new Date(
                    qrExpiresAt
                ).toISOString()
                : null,

        pairing_code:
            pairingCode || null,

        pairing_phone:
            pairingPhone || null,

        pairing_phone_display:
            pairingPhone
                ? '+' + pairingPhone
                : null,

        last_error:
            lastError || null,

        last_disconnect:
            lastDisconnect || null,

        reconnect_attempts:
            reconnectAttempts,

        desired_mode:
            desiredMode,

        version:
            '3.0.0'
    });
});


/* ============================================================
 * QR
 * ============================================================
 */

app.get('/qr', (req, res) => {

    const valid =
        currentQR &&
        qrImage &&
        qrExpiresAt &&
        Date.now() < qrExpiresAt;

    if (!valid) {

        return res.status(404).json({

            success: false,

            error:
                'QR not available or expired',

            status:
                connectionStatus,

            qr_available:
                false,

            expires_at:
                qrExpiresAt
                    ? new Date(
                        qrExpiresAt
                    ).toISOString()
                    : null
        });
    }

    res.json({

        success: true,

        qr:
            currentQR,

        qr_image:
            qrImage,

        created_at:
            new Date(
                qrCreatedAt
            ).toISOString(),

        expires_at:
            new Date(
                qrExpiresAt
            ).toISOString(),

        expires_in:
            Math.max(
                0,
                Math.floor(
                    (
                        qrExpiresAt -
                        Date.now()
                    ) / 1000
                )
            )
    });
});


/* ============================================================
 * CONNECT
 * ============================================================
 */

app.post('/connect', async (req, res) => {

    try {

        stopRequested = false;

        desiredMode =
            'qr';

        pairingPhone =
            null;

        pairingCode =
            null;

        phone =
            null;

        pushName =
            null;

        connectedAt =
            null;

        lastError =
            null;

        reconnectAttempts =
            0;

        clearQR();

        cancelReconnect();

        await restartSocket(
            'Manual QR connect'
        );

        res.json({

            success: true,

            message:
                'QR connection started',

            status:
                connectionStatus
        });

    } catch (err) {

        lastError =
            err.message;

        res.status(500).json({

            success: false,

            error:
                err.message
        });
    }
});


/* ============================================================
 * PAIR
 * ============================================================
 */

app.post('/pair', async (req, res) => {

    try {

        const input =
            req.body?.phone ||
            req.body?.number ||
            req.body?.mobile;

        if (!input) {

            return res.status(400).json({

                success: false,

                error:
                    'Phone number is required'
            });
        }


        /*
         * Automatically normalize country.
         */
        const info =
            getPhoneInfo(
                input
            );


        log(
            '[PAIR REQUEST]',
            info.international,
            info.country
        );


        /*
         * Stop current connection first.
         */
        stopRequested = false;

        desiredMode =
            'pair';

        pairingPhone =
            info.digits;

        pairingCode =
            null;

        clearQR();

        phone =
            null;

        pushName =
            null;

        connectedAt =
            null;

        lastError =
            null;

        reconnectAttempts =
            0;

        cancelReconnect();

        await restartSocket(
            'Manual pairing request'
        );


        /*
         * Wait up to 8 seconds for pairing code.
         */
        const started =
            Date.now();

        while (
            !pairingCode &&
            Date.now() - started <
            8000
        ) {

            await sleep(200);
        }


        if (!pairingCode) {

            return res.status(504).json({

                success: false,

                error:
                    lastError ||
                    'Pairing code was not generated',

                phone:
                    info.international,

                country:
                    info.country,

                status:
                    connectionStatus
            });
        }


        res.json({

            success: true,

            message:
                'Pairing code generated',

            pairing_code:
                pairingCode,

            phone:
                info.international,

            phone_digits:
                info.digits,

            country:
                info.country,

            country_calling_code:
                info.callingCode,

            status:
                connectionStatus
        });

    } catch (err) {

        lastError =
            err.message;

        res.status(400).json({

            success: false,

            error:
                err.message
        });
    }
});


/* ============================================================
 * DISCONNECT
 * ============================================================
 */

app.post('/disconnect', async (req, res) => {

    try {

        stopRequested = true;

        desiredMode =
            null;

        cancelReconnect();

        clearWatchdogs();

        clearQR();

        pairingCode =
            null;

        await closeSocket();

        connectionStatus =
            'disconnected';

        phone =
            null;

        pushName =
            null;

        connectedAt =
            null;

        res.json({

            success: true,

            message:
                'Disconnected',

            status:
                connectionStatus
        });

    } catch (err) {

        res.status(500).json({

            success: false,

            error:
                err.message
        });
    }
});


/* ============================================================
 * RESET
 * ============================================================
 */

app.post('/reset', async (req, res) => {

    try {

        stopRequested = true;

        desiredMode =
            null;

        cancelReconnect();

        clearWatchdogs();

        clearQR();

        pairingCode =
            null;

        await closeSocket();


        /*
         * Delete authentication.
         */
        if (
            fs.existsSync(
                AUTH_DIR
            )
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


        authState =
            null;

        saveCreds =
            null;

        phone =
            null;

        pushName =
            null;

        connectedAt =
            null;

        lastError =
            null;

        lastDisconnect =
            null;

        reconnectAttempts =
            0;

        connectionStatus =
            'disconnected';

        stopRequested =
            false;

        res.json({

            success: true,

            message:
                'Session reset successfully',

            status:
                connectionStatus
        });

    } catch (err) {

        res.status(500).json({

            success: false,

            error:
                err.message
        });
    }
});


/* ============================================================
 * SEND MESSAGE
 * ============================================================
 */

app.post('/send-message', async (req, res) => {

    try {

        if (
            !sock ||
            connectionStatus !==
            'connected'
        ) {

            return res.status(503).json({

                success: false,

                error:
                    'WhatsApp is not connected'
            });
        }


        const input =
            req.body?.to ||
            req.body?.phone ||
            req.body?.number;

        const text =
            req.body?.message ??
            req.body?.text ??
            '';


        if (!input) {

            return res.status(400).json({

                success: false,

                error:
                    'Recipient phone number is required'
            });
        }


        if (!String(text).trim()) {

            return res.status(400).json({

                success: false,

                error:
                    'Message is required'
            });
        }


        const info =
            normalizePhoneNumber(
                input
            );

        const jid =
            info.digits +
            '@s.whatsapp.net';


        const result =
            await sock.sendMessage(
                jid,
                {
                    text: String(text)
                }
            );


        res.json({

            success: true,

            message:
                'Message sent',

            to:
                info.e164,

            jid:
                jid,

            message_id:
                result?.key?.id ||
                null
        });

    } catch (err) {

        lastError =
            err.message;

        res.status(500).json({

            success: false,

            error:
                err.message
        });
    }
});


/* ============================================================
 * SEND MEDIA
 * ============================================================
 */

app.post('/send-media', async (req, res) => {

    try {

        if (
            !sock ||
            connectionStatus !==
            'connected'
        ) {

            return res.status(503).json({

                success: false,

                error:
                    'WhatsApp is not connected'
            });
        }


        const input =
            req.body?.to ||
            req.body?.phone ||
            req.body?.number;

        const type =
            String(
                req.body?.type ||
                'document'
            ).toLowerCase();

        const caption =
            req.body?.caption ||
            '';

        const url =
            req.body?.url ||
            req.body?.media ||
            req.body?.file;


        if (!input) {

            return res.status(400).json({

                success: false,

                error:
                    'Recipient is required'
            });
        }


        if (!url) {

            return res.status(400).json({

                success: false,

                error:
                    'Media URL is required'
            });
        }


        const info =
            normalizePhoneNumber(
                input
            );

        const jid =
            info.digits +
            '@s.whatsapp.net';


        let content;


        switch (type) {

            case 'image':

                content = {
                    image: {
                        url
                    },
                    caption
                };

                break;


            case 'video':

                content = {
                    video: {
                        url
                    },
                    caption
                };

                break;


            case 'audio':

                content = {
                    audio: {
                        url
                    },
                    mimetype:
                        req.body?.mimetype ||
                        'audio/mpeg'
                };

                break;


            case 'document':

            default:

                content = {
                    document: {
                        url
                    },
                    mimetype:
                        req.body?.mimetype ||
                        'application/octet-stream',
                    fileName:
                        req.body?.filename ||
                        'file'
                };

                if (caption) {
                    content.caption =
                        caption;
                }

                break;
        }


        const result =
            await sock.sendMessage(
                jid,
                content
            );


        res.json({

            success: true,

            message:
                'Media sent',

            to:
                info.e164,

            type,

            message_id:
                result?.key?.id ||
                null
        });

    } catch (err) {

        lastError =
            err.message;

        res.status(500).json({

            success: false,

            error:
                err.message
        });
    }
});


/* ============================================================
 * PHONE CHECK
 * ============================================================
 */

app.post('/phone-check', (req, res) => {

    try {

        const input =
            req.body?.phone ||
            req.body?.number;

        if (!input) {

            return res.status(400).json({

                success: false,

                error:
                    'Phone number is required'
            });
        }

        res.json(
            getPhoneInfo(
                input
            )
        );

    } catch (err) {

        res.status(400).json({

            success: false,

            error:
                err.message
        });
    }
});


/* ============================================================
 * 404
 * ============================================================
 */

app.use((req, res) => {

    res.status(404).json({

        success: false,

        error:
            'Endpoint not found',

        path:
            req.path
    });
});


/* ============================================================
 * ERROR HANDLER
 * ============================================================
 */

app.use(
    (err, req, res, next) => {

        errorLog(
            '[EXPRESS]',
            err
        );

        res.status(500).json({

            success: false,

            error:
                err.message ||
                'Internal server error'
        });
    }
);


/* ============================================================
 * START SERVER
 * ============================================================
 */

const server =
    app.listen(
        PORT,
        '0.0.0.0',
        () => {

            console.log('');
            console.log(
                '=========================================='
            );
            console.log(
                ' RB WhatsApp Connector 3.0.0'
            );
            console.log(
                '=========================================='
            );
            console.log(
                ` Port: ${PORT}`
            );
            console.log(
                ` Default country: ${DEFAULT_COUNTRY}`
            );
            console.log(
                ' QR expiry: 5 minutes'
            );
            console.log(
                ` Auth: ${AUTH_DIR}`
            );
            console.log(
                '=========================================='
            );
            console.log('');
        }
    );


/* ============================================================
 * AUTO CONNECT EXISTING SESSION
 * ============================================================
 */

(async () => {

    try {

        /*
         * Give Express a moment to start.
         */
        await sleep(500);

        const hasAuth =
            fs.existsSync(
                AUTH_DIR
            ) &&
            fs.readdirSync(
                AUTH_DIR
            ).length > 0;

        if (hasAuth) {

            log(
                '[BOOT] Existing auth found, connecting...'
            );

            stopRequested =
                false;

            desiredMode =
                'qr';

            await startSocket(
                'qr'
            );

        } else {

            log(
                '[BOOT] No WhatsApp session found.'
            );

            log(
                '[BOOT] Waiting for /connect or /pair'
            );
        }

    } catch (err) {

        errorLog(
            '[BOOT]',
            err.message
        );
    }

})();


/* ============================================================
 * GRACEFUL SHUTDOWN
 * ============================================================
 */

async function shutdown(signal) {

    console.log(
        `\n[SHUTDOWN] ${signal}`
    );

    stopRequested =
        true;

    desiredMode =
        null;

    cancelReconnect();

    clearWatchdogs();

    clearQR();

    try {

        await closeSocket();

    } catch {}

    try {

        server.close();

    } catch {}

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


/* ============================================================
 * UNHANDLED ERRORS
 * ============================================================
 */

process.on(
    'unhandledRejection',
    reason => {

        errorLog(
            '[UNHANDLED REJECTION]',
            reason
        );
    }
);


process.on(
    'uncaughtException',
    err => {

        errorLog(
            '[UNCAUGHT EXCEPTION]',
            err
        );
    }
);
