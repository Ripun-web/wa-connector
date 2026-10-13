# RB WhatsApp Connector

Simple Node.js + Baileys WhatsApp connector for Ubuntu/Linux hosting.

## Services kept

- QR connection
- Automatic reconnect
- Send one-to-one text messages
- Health and status
- Disconnect
- OTP request and verification service
- No AI features
- No campaign/bulk engine
- No API key required

## OTP API

### Send OTP

`POST /send-otp`

Also supported: `POST /otp/request`

```json
{
  "phone": "9876543210"
}
```

### Verify OTP

`POST /verify-otp`

Also supported: `POST /otp/verify`

```json
{
  "phone": "9876543210",
  "otp": "123456"
}
```

OTP defaults:

- 6 digits
- 5 minute expiry
- 60 second resend cooldown
- 5 requests per number per hour
- 5 failed verification attempts per OTP
- 3 second minimum delay between outgoing messages
- OTP hash stored in memory, not plaintext

## Normal API

- `GET /`
- `GET /health`
- `GET /status`
- `GET /qr`
- `GET /qr.png`
- `POST /connect`
- `POST /send-message`
- `POST /disconnect`

No API key is required for these endpoints.

## Install on Ubuntu / Railway

Requirements:

- Ubuntu/Linux
- Node.js 20+
- npm

```bash
git clone https://github.com/Ripun-web/wa-connector.git
cd wa-connector
npm install
cp .env.example .env
npm start
```

Railway can use `npm start` as the start command and will provide the `PORT` environment variable.

## GitHub Actions

CI uses `ubuntu-latest` only. No macOS runner is used.

## Important usage note

There is no technical way to guarantee that a WhatsApp account will never be banned. This connector does not provide a "no-ban" guarantee. Use it for legitimate, consented messaging, avoid spam/unwanted automation, and follow WhatsApp requirements.
