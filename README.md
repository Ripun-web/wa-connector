# RB WhatsApp Connector

Simple Node.js + Baileys WhatsApp connector for Ubuntu/Linux hosting.

## Included

- QR connection
- Automatic reconnect
- Send one-to-one text messages
- OTP request and verification service
- API token authentication
- Health and status endpoints
- Basic per-number OTP rate limits
- Ubuntu GitHub Actions check
- No AI features
- No campaign/bulk-message engine

## Important

There is no technical way to guarantee that a WhatsApp account will never be banned. Use this connector only for legitimate messaging, obtain recipient consent, respect WhatsApp rules, and avoid spam or unwanted automation.

## Requirements

- Ubuntu/Linux
- Node.js 20+
- npm

## Install

```bash
git clone https://github.com/Ripun-web/wa-connector.git
cd wa-connector
npm install
cp .env.example .env
```

Set a strong `CONNECTOR_API_TOKEN` in `.env`, then start:

```bash
npm start
```

Default port: `3000`.

## Endpoints

All endpoints except `/health` require `Authorization: Bearer YOUR_TOKEN` or `X-API-Token: YOUR_TOKEN`.

### Health

`GET /health`

### Status

`GET /status`

### Start WhatsApp connection

`POST /connect`

Then use `GET /qr.png` to obtain the QR image when available.

### Send message

`POST /send-message`

JSON:

```json
{
  "phone": "9876543210",
  "message": "Hello"
}
```

### Request OTP

`POST /otp/request`

JSON:

```json
{
  "phone": "9876543210"
}
```

The service creates a random 6-digit OTP, stores only its SHA-256 hash in memory, and sends the OTP through the connected WhatsApp account. Default expiry is 5 minutes.

### Verify OTP

`POST /otp/verify`

JSON:

```json
{
  "phone": "9876543210",
  "otp": "123456"
}
```

Successful verification consumes the OTP.

### Disconnect

`POST /disconnect`

## OTP protection

Defaults:

- 6-digit OTP
- 5-minute expiry
- 60-second resend cooldown
- 5 OTP requests per number per hour
- 3-second minimum delay between outgoing messages

These are application-level controls, not WhatsApp guarantees.

## cPanel / Node.js application

Use Node.js 20 or newer.

- Application root: repository folder, for example `wa-connector`
- Application URL: your chosen domain/subdomain
- Startup file: `connector.js`
- Application mode: Production
- Environment variables: copy values from `.env.example`

After dependencies are installed, restart the Node.js application.

## Ubuntu GitHub Actions

The repository uses `ubuntu-latest` only for CI. No macOS runner is required.

## License

Use responsibly and comply with applicable WhatsApp and local requirements.
