'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

// Ubuntu/VPS persistent folder
const AUTH_DIR =
    process.env.AUTH_DIR ||
    path.join(__dirname, 'auth_info');

const API_TOKEN = process.env.API_TOKEN || '';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info'
});

app.use(express.json({
    limit: '50mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '50mb'
}));

// ======================================================
// GLOBAL STATE
// ======================================================

let sock = null;
let starting = false;

let state = {
    status: 'disconnected',
    qr: null,
    qr_image: null,
    qr_expires_at: null,
    pairing_code: null,
    phone: null,
    connected_at: null,
    last_error: null
};

// ======================================================
// AUTH DIRECTORY
// ======================================================

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, {
        recursive: true
    });
}

console.log('======================================');
console.log('WA CONNECTOR');
console.log('======================================');
console.log('AUTH_DIR:', AUTH_DIR);
console.log('PORT:', PORT);
console.log('HOST:', HOST);
console.log('======================================');

// ======================================================
// TOKEN MIDDLEWARE
// ======================================================

function authMiddleware(req, res, next) {

    if (!API_TOKEN) {
        return next();
    }

    // Allow health check
    if (req.path === '/health') {
        return next();
    }

    const auth = req.headers.authorization || '';
    const token = req.headers['x-connector-token'] || '';

    let supplied = '';

    if (auth.startsWith('Bearer ')) {
        supplied = auth.substring(7).trim();
    }

    if (!supplied && token) {
        supplied = token;
    }

    if (supplied !== API_TOKEN) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }

    next();
}

app.use(authMiddleware);

// ======================================================
// HELPERS
// ======================================================

function setStatus(status, extra = {}) {

    state.status = status;

    Object.assign(state, extra);

    if (status !== 'qr') {
        state.qr = null;
        state.qr_image = null;
        state.qr_expires_at = null;
    }
}

function isConnected() {

    return !!(
        sock &&
        sock.user &&
        state.status === 'connected'
    );
}

function getStatus() {

    return {
        success: true,
        status: state.status,
        connected: isConnected(),
        phone: state.phone,
        connected_at: state.connected_at,
        qr_available: !!state.qr_image,
        qr_expires_at: state.qr_expires_at,
        pairing_code: state.pairing_code,
        last_error: state.last_error
    };
}

// ======================================================
// WAIT FOR SOCKET
// ======================================================

function waitForSocket(timeout = 30000) {

    return new Promise((resolve, reject) => {

        const started = Date.now();

        const timer = setInterval(() => {

            if (isConnected()) {
                clearInterval(timer);
                return resolve(sock);
            }

            if (Date.now() - started > timeout) {
                clearInterval(timer);

                return reject(
                    new Error('WhatsApp connection timeout')
                );
            }

        }, 500);
    });
}

// ======================================================
// STOP SOCKET
// ======================================================

async function teardownSocket() {

    if (!sock) {
        return;
    }

    try {

        sock.ev.removeAllListeners();

        try {
            sock.ws?.close();
        } catch (_) {}

    } catch (e) {

        logger.warn({
            error: e.message
        }, 'Socket cleanup error');
    }

    sock = null;

    setStatus('disconnected', {
        phone: null,
        pairing_code: null
    });
}

// ======================================================
// START WHATSAPP
// ======================================================

async function startSocket(mode = 'qr', pairingPhone = '') {

    if (starting) {
        return;
    }

    starting = true;

    try {

        await teardownSocket();

        setStatus('connecting', {
            last_error: null,
            pairing_code: null
        });

        console.log('Starting WhatsApp socket...');
        console.log('Mode:', mode);

        const {
            state: authState,
            saveCreds
        } = await useMultiFileAuthState(AUTH_DIR);

        let version;

        try {

            const latest =
                await fetchLatestBaileysVersion();

            version = latest.version;

            console.log(
                'Baileys version:',
                version.join('.')
            );

        } catch (e) {

            console.log(
                'Could not fetch latest Baileys version:',
                e.message
            );
        }

        const options = {

            auth: authState,

            logger,

            browser: Browsers.macOS('Chrome'),

            printQRInTerminal: false,

            syncFullHistory: false,

            markOnlineOnConnect: false,

            generateHighQualityLinkPreview: false
        };

        if (version) {
            options.version = version;
        }

        sock = makeWASocket(options);

        // ==================================================
        // SAVE AUTH
        // ==================================================

        sock.ev.on('creds.update', saveCreds);

        // ==================================================
        // CONNECTION EVENTS
        // ==================================================

        sock.ev.on(
            'connection.update',
            async (update) => {

                const {
                    connection,
                    lastDisconnect,
                    qr
                } = update;

                // ------------------------------------------
                // QR
                // ------------------------------------------

                if (qr) {

                    try {

                        const image =
                            await QRCode.toDataURL(qr, {
                                width: 400,
                                margin: 2
                            });

                        state.qr = qr;
                        state.qr_image = image;

                        state.qr_expires_at =
                            Date.now() + 45000;

                        state.status = 'qr';

                        console.log(
                            'QR code generated'
                        );

                    } catch (e) {

                        logger.error({
                            error: e.message
                        }, 'QR generation failed');
                    }
                }

                // ------------------------------------------
                // CONNECTING
                // ------------------------------------------

                if (connection === 'connecting') {

                    console.log(
                        'WhatsApp connecting...'
                    );

                    setStatus('connecting', {
                        last_error: null
                    });
                }

                // ------------------------------------------
                // OPEN
                // ------------------------------------------

                if (connection === 'open') {

                    console.log(
                        'WhatsApp connected successfully'
                    );

                    const me = sock.user;

                    state.phone =
                        me?.id
                            ? me.id.split(':')[0]
                            : null;

                    state.connected_at =
                        new Date().toISOString();

                    state.last_error = null;

                    state.qr = null;
                    state.qr_image = null;
                    state.qr_expires_at = null;

                    state.pairing_code = null;

                    state.status = 'connected';

                    console.log(
                        'Connected phone:',
                        state.phone
                    );
                }

                // ------------------------------------------
                // CLOSED
                // ------------------------------------------

                if (connection === 'close') {

                    let shouldReconnect = true;

                    let errorMessage =
                        'WhatsApp connection closed';

                    if (lastDisconnect?.error) {

                        errorMessage =
                            lastDisconnect.error.message ||
                            errorMessage;
                    }

                    const statusCode =
                        lastDisconnect?.error?.output?.statusCode;

                    console.log(
                        'Connection closed:',
                        statusCode,
                        errorMessage
                    );

                    if (
                        statusCode ===
                        DisconnectReason.loggedOut
                    ) {
                        shouldReconnect = false;

                        console.log(
                            'WhatsApp logged out'
                        );

                        setStatus('logged_out', {
                            last_error: errorMessage
                        });

                    } else {

                        setStatus('disconnected', {
                            last_error: errorMessage
                        });
                    }

                    sock = null;

                    if (shouldReconnect) {

                        setTimeout(() => {

                            if (!sock && !starting) {

                                startSocket('qr')
                                    .catch(err => {

                                        logger.error({
                                            error: err.message
                                        },
                                        'Reconnect failed');

                                    });

                            }

                        }, 3000);
                    }
                }
            }
        );

        // ==================================================
        // PAIRING CODE
        // ==================================================

        if (
            mode === 'pair' &&
            pairingPhone
        ) {

            let cleanPhone =
                String(pairingPhone)
                    .replace(/\D/g, '');

            if (!cleanPhone) {
                throw new Error(
                    'Invalid phone number'
                );
            }

            console.log(
                'Waiting for pairing socket...'
            );

            await new Promise(resolve =>
                setTimeout(resolve, 2000)
            );

            try {

                const code =
                    await sock.requestPairingCode(
                        cleanPhone
                    );

                state.pairing_code = code;
                state.phone = cleanPhone;
                state.status = 'pairing';

                console.log(
                    'Pairing code:',
                    code
                );

            } catch (e) {

                logger.error({
                    error: e.message
                }, 'Pairing code failed');

                state.last_error = e.message;
            }
        }

    } catch (e) {

        state.status = 'error';
        state.last_error = e.message;

        console.error(
            'Socket start error:',
            e
        );

        sock = null;

        throw e;

    } finally {

        starting = false;
    }
}

// ======================================================
// WEB UI
// ======================================================

function renderConnectPage() {

    return `<!DOCTYPE html>
<html lang="en">
<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>WhatsApp Connector</title>

<style>

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    min-height: 100vh;

    font-family:
        Inter,
        Arial,
        sans-serif;

    background:
        linear-gradient(
            135deg,
            #0f172a,
            #111827
        );

    color: white;

    display: flex;
    align-items: center;
    justify-content: center;

    padding: 20px;
}

.container {
    width: 100%;
    max-width: 650px;
}

.card {
    background:
        rgba(255,255,255,.08);

    border:
        1px solid rgba(255,255,255,.12);

    backdrop-filter: blur(20px);

    border-radius: 24px;

    padding: 30px;

    box-shadow:
        0 30px 80px rgba(0,0,0,.35);
}

.logo {
    width: 70px;
    height: 70px;

    margin: 0 auto 15px;

    border-radius: 20px;

    display: flex;
    align-items: center;
    justify-content: center;

    font-size: 35px;

    background: #25D366;

    color: white;
}

h1 {
    text-align: center;
    margin: 0;
}

.subtitle {
    text-align: center;
    opacity: .7;
    margin: 8px 0 25px;
}

.status {
    padding: 15px;
    border-radius: 14px;

    background:
        rgba(255,255,255,.06);

    margin-bottom: 20px;

    text-align: center;
}

.status span {
    font-weight: 700;
}

.qr {
    display: none;

    background: white;

    padding: 15px;

    border-radius: 20px;

    margin: 20px auto;

    width: fit-content;
}

.qr img {
    width: 280px;
    height: 280px;
}

.buttons {
    display: grid;

    grid-template-columns:
        repeat(2, 1fr);

    gap: 10px;

    margin-top: 20px;
}

button {
    border: 0;

    padding: 14px;

    border-radius: 12px;

    cursor: pointer;

    font-size: 15px;
    font-weight: 700;
}

.primary {
    background: #25D366;
    color: white;
}

.dark {
    background: #334155;
    color: white;
}

.red {
    background: #ef4444;
    color: white;
}

input {
    width: 100%;

    padding: 14px;

    border-radius: 12px;

    border: 1px solid
        rgba(255,255,255,.15);

    background:
        rgba(0,0,0,.2);

    color: white;

    outline: none;

    margin-top: 8px;
}

.pair {
    margin-top: 20px;

    padding: 18px;

    background:
        rgba(255,255,255,.05);

    border-radius: 15px;
}

.code {
    font-size: 28px;

    font-weight: 800;

    letter-spacing: 5px;

    text-align: center;

    margin-top: 15px;

    color: #25D366;
}

pre {
    white-space: pre-wrap;
    word-break: break-word;

    background: #020617;

    padding: 15px;

    border-radius: 12px;

    font-size: 12px;
}

@media(max-width:500px) {

    .card {
        padding: 20px;
    }

    .buttons {
        grid-template-columns: 1fr;
    }

    .qr img {
        width: 240px;
        height: 240px;
    }
}

</style>

</head>

<body>

<div class="container">

<div class="card">

<div class="logo">☏</div>

<h1>WhatsApp Connector</h1>

<div class="subtitle">
Baileys WhatsApp API Connector
</div>

<div class="status">
Status:
<strong id="status">
Loading...
</strong>
</div>

<div
    id="qrBox"
    class="qr"
>
<img
    id="qr"
    src=""
    alt="WhatsApp QR Code"
>
</div>

<div
    id="pairBox"
    class="pair"
>

<strong>
Pair using phone number
</strong>

<input
    id="phone"
    type="text"
    placeholder="919876543210"
>

<button
    class="primary"
    style="width:100%;margin-top:10px"
    onclick="pair()"
>
Generate Pairing Code
</button>

<div
    id="pairCode"
    class="code"
></div>

</div>

<div class="buttons">

<button
    class="primary"
    onclick="connectQR()"
>
Connect with QR
</button>

<button
    class="dark"
    onclick="refreshStatus()"
>
Refresh
</button>

<button
    class="red"
    onclick="disconnect()"
>
Disconnect
</button>

<button
    class="dark"
    onclick="resetConnector()"
>
Reset Session
</button>

</div>

<pre id="output">
Ready.
</pre>

</div>

</div>

<script>

async function request(
    url,
    options = {}
) {

    const response =
        await fetch(url, options);

    const text =
        await response.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        data = {
            success: false,
            error: text
        };
    }

    if (!response.ok) {
        throw new Error(
            data.error ||
            'Request failed'
        );
    }

    return data;
}

function show(data) {

    document.getElementById(
        'output'
    ).textContent =
        JSON.stringify(
            data,
            null,
            2
        );
}

async function refreshStatus() {

    try {

        const data =
            await request('/status');

        document.getElementById(
            'status'
        ).textContent =
            data.status;

        show(data);

        if (
            data.qr_available &&
            data.status === 'qr'
        ) {

            const qr =
                document.getElementById('qr');

            qr.src =
                '/qr-image?t=' +
                Date.now();

            document.getElementById(
                'qrBox'
            ).style.display = 'block';

        } else {

            document.getElementById(
                'qrBox'
            ).style.display = 'none';
        }

        if (data.pairing_code) {

            document.getElementById(
                'pairCode'
            ).textContent =
                data.pairing_code;

        }

    } catch (e) {

        document.getElementById(
            'status'
        ).textContent =
            'Error';

        show({
            error: e.message
        });
    }
}

async function connectQR() {

    try {

        const data =
            await request(
                '/connect',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },

                    body: JSON.stringify({
                        mode: 'qr'
                    })
                }
            );

        show(data);

        setTimeout(
            refreshStatus,
            1000
        );

    } catch (e) {

        show({
            error: e.message
        });
    }
}

async function pair() {

    const phone =
        document.getElementById(
            'phone'
        ).value.trim();

    if (!phone) {

        alert(
            'Enter phone number with country code'
        );

        return;
    }

    try {

        const data =
            await request(
                '/pair',
                {
                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json'
                    },

                    body: JSON.stringify({
                        phone
                    })
                }
            );

        show(data);

        setTimeout(
            refreshStatus,
            1000
        );

    } catch (e) {

        show({
            error: e.message
        });
    }
}

async function disconnect() {

    if (!confirm(
        'Disconnect WhatsApp?'
    )) {
        return;
    }

    try {

        const data =
            await request(
                '/disconnect',
                {
                    method: 'POST'
                }
            );

        show(data);

        setTimeout(
            refreshStatus,
            500
        );

    } catch (e) {

        show({
            error: e.message
        });
    }
}

async function resetConnector() {

    if (!confirm(
        'Reset WhatsApp session? You will need to connect again.'
    )) {
        return;
    }

    try {

        const data =
            await request(
                '/reset',
                {
                    method: 'POST'
                }
            );

        show(data);

        setTimeout(
            refreshStatus,
            1000
        );

    } catch (e) {

        show({
            error: e.message
        });
    }
}

refreshStatus();

setInterval(
    refreshStatus,
    5000
);

</script>

</body>
</html>`;
}

// ======================================================
// ROOT PAGE
// ======================================================

// IMPORTANT FIX
app.get('/', (req, res) => {
    res.send(renderConnectPage());
});

// Also allow /connect in browser
app.get('/connect', (req, res) => {
    res.send(renderConnectPage());
});

// ======================================================
// HEALTH
// ======================================================

app.get('/health', (req, res) => {

    res.json({
        ok: true,
        service: 'wa-connector',
        version: '3.0.0',
        status: state.status,
        connected: isConnected(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ======================================================
// STATUS
// ======================================================

app.get('/status', (req, res) => {

    res.json(
        getStatus()
    );
});

// ======================================================
// QR IMAGE
// ======================================================

app.get('/qr-image', (req, res) => {

    if (!state.qr_image) {

        return res.status(404).json({
            success: false,
            error: 'QR code not available'
        });
    }

    const base64 =
        state.qr_image
            .replace(
                /^data:image\/png;base64,/,
                ''
            );

    const buffer =
        Buffer.from(
            base64,
            'base64'
        );

    res.setHeader(
        'Content-Type',
        'image/png'
    );

    res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate'
    );

    res.send(buffer);
});

// ======================================================
// QR RAW DATA
// ======================================================

app.get('/qr', (req, res) => {

    if (!state.qr) {

        return res.status(404).json({
            success: false,
            error: 'QR code not available'
        });
    }

    res.json({
        success: true,
        qr: state.qr,
        expires_at: state.qr_expires_at
    });
});

// ======================================================
// CONNECT
// ======================================================

app.post('/connect', async (req, res) => {

    if (starting) {

        return res.json({
            success: true,
            status: 'connecting',
            message: 'Connection is already starting'
        });
    }

    if (isConnected()) {

        return res.json({
            success: true,
            status: 'connected',
            message: 'Already connected'
        });
    }

    startSocket('qr')
        .catch(err => {

            logger.error({
                error: err.message
            }, 'QR connection failed');

        });

    res.json({
        success: true,
        status: 'connecting',
        message: 'WhatsApp connection started'
    });
});

// ======================================================
// PAIR
// ======================================================

app.post('/pair', async (req, res) => {

    const phone =
        req.body?.phone ||
        req.body?.number ||
        '';

    const cleanPhone =
        String(phone)
            .replace(/\D/g, '');

    if (!cleanPhone) {

        return res.status(400).json({
            success: false,
            error:
                'Phone number is required'
        });
    }

    if (starting) {

        return res.status(409).json({
            success: false,
            error:
                'Another connection is starting'
        });
    }

    try {

        await startSocket(
            'pair',
            cleanPhone
        );

        res.json({
            success: true,
            status: state.status,
            pairing_code:
                state.pairing_code,
            phone: cleanPhone
        });

    } catch (e) {

        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// ======================================================
// DISCONNECT
// ======================================================

app.post('/disconnect', async (req, res) => {

    try {

        await teardownSocket();

        res.json({
            success: true,
            status: 'disconnected'
        });

    } catch (e) {

        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// ======================================================
// RESET SESSION
// ======================================================

app.post('/reset', async (req, res) => {

    try {

        await teardownSocket();

        if (fs.existsSync(AUTH_DIR)) {

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

        state = {
            status: 'disconnected',
            qr: null,
            qr_image: null,
            qr_expires_at: null,
            pairing_code: null,
            phone: null,
            connected_at: null,
            last_error: null
        };

        res.json({
            success: true,
            status: 'reset',
            message:
                'WhatsApp session reset successfully'
        });

    } catch (e) {

        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// GET reset
app.get('/reset', async (req, res) => {

    res.json({
        success: false,
        error:
            'Use POST /reset to reset the session'
    });
});

// ======================================================
// SEND MESSAGE
// ======================================================

app.post('/send-message', async (req, res) => {

    try {

        if (!isConnected()) {

            return res.status(503).json({
                success: false,
                error:
                    'WhatsApp is not connected'
            });
        }

        const to =
            req.body?.to ||
            req.body?.phone ||
            '';

        const message =
            req.body?.message ||
            req.body?.text ||
            '';

        if (!to) {

            return res.status(400).json({
                success: false,
                error:
                    'Recipient phone number is required'
            });
        }

        if (!message) {

            return res.status(400).json({
                success: false,
                error:
                    'Message is required'
            });
        }

        const jid =
            to.includes('@')
                ? to
                : `${String(to).replace(/\D/g, '')}@s.whatsapp.net`;

        const result =
            await sock.sendMessage(
                jid,
                {
                    text: String(message)
                }
            );

        res.json({
            success: true,
            message_id:
                result?.key?.id || null
        });

    } catch (e) {

        logger.error({
            error: e.message
        }, 'Send message failed');

        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// ======================================================
// SEND MEDIA
// ======================================================

app.post('/send-media', async (req, res) => {

    try {

        if (!isConnected()) {

            return res.status(503).json({
                success: false,
                error:
                    'WhatsApp is not connected'
            });
        }

        const to =
            req.body?.to ||
            req.body?.phone ||
            '';

        const url =
            req.body?.url ||
            '';

        const caption =
            req.body?.caption ||
            '';

        const type =
            req.body?.type ||
            'image';

        if (!to) {

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

        const jid =
            to.includes('@')
                ? to
                : `${String(to).replace(/\D/g, '')}@s.whatsapp.net`;

        let content;

        if (type === 'image') {

            content = {
                image: {
                    url
                },
                caption
            };

        } else if (type === 'video') {

            content = {
                video: {
                    url
                },
                caption
            };

        } else if (type === 'audio') {

            content = {
                audio: {
                    url
                },
                mimetype:
                    'audio/mp4',
                ptt:
                    Boolean(
                        req.body?.ptt
                    )
            };

        } else if (type === 'document') {

            content = {
                document: {
                    url
                },
                mimetype:
                    req.body?.mimetype ||
                    'application/octet-stream',
                fileName:
                    req.body?.fileName ||
                    'document'
            };

        } else {

            return res.status(400).json({
                success: false,
                error:
                    'Unsupported media type'
            });
        }

        const result =
            await sock.sendMessage(
                jid,
                content
            );

        res.json({
            success: true,
            message_id:
                result?.key?.id || null
        });

    } catch (e) {

        logger.error({
            error: e.message
        }, 'Send media failed');

        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// ======================================================
// 404
// ======================================================

app.use((req, res) => {

    res.status(404).json({
        success: false,
        error: 'Route not found',
        path: req.path
    });
});

// ======================================================
// ERROR HANDLER
// ======================================================

app.use((err, req, res, next) => {

    logger.error({
        error: err.message
    });

    res.status(500).json({
        success: false,
        error: err.message
    });
});

// ======================================================
// START SERVER
// ======================================================

app.listen(
    PORT,
    HOST,
    () => {

        console.log('');
        console.log(
            '======================================'
        );

        console.log(
            `WA Connector running on http://${HOST}:${PORT}`
        );

        console.log(
            '======================================'
        );

        console.log(
            `Health: http://localhost:${PORT}/health`
        );

        console.log(
            `Status: http://localhost:${PORT}/status`
        );

        console.log(
            '======================================'
        );
    }
);

// ======================================================
// PROCESS HANDLERS
// ======================================================

process.on(
    'SIGINT',
    async () => {

        console.log(
            'Stopping connector...'
        );

        await teardownSocket();

        process.exit(0);
    }
);

process.on(
    'SIGTERM',
    async () => {

        console.log(
            'Stopping connector...'
        );

        await teardownSocket();

        process.exit(0);
    }
);
