# 🚀 WhatsApp MSG API — FREE & Self-Hostable

### WhatsApp Messaging API • QR Connect • Pairing Code • Bulk Messaging • AI Auto Reply • Multi-Account

**Developed by RB Developments — Ripun Baruah**

Build your own WhatsApp automation backend for websites, applications, CRM systems, notification systems and AI chatbots.

This project provides a Node.js/Express REST API around a WhatsApp Web connection, allowing your application to connect a WhatsApp account and perform messaging operations programmatically.

> ⚠️ **Important:** This is a self-hosted WhatsApp Web automation project. It is **not the official WhatsApp Cloud API**. Use it responsibly and follow WhatsApp's applicable terms, policies and recipient-consent requirements.

---

## ⭐ Features

### 📱 WhatsApp Connection

* ✅ QR Code Login
* ✅ Pairing Code Login
* ✅ Multi-account support
* ✅ Persistent authentication sessions
* ✅ Automatic reconnection
* ✅ Connection status
* ✅ Online/presence handling
* ✅ Account-specific sessions

### 💬 Messaging

* ✅ Send text messages
* ✅ Send media
* ✅ Send documents
* ✅ Send images
* ✅ API-based messaging
* ✅ Account-specific messaging
* ✅ Incoming message events
* ✅ Automatic replies

### 🤖 AI Automation

* ✅ OpenAI integration
* ✅ AI auto reply
* ✅ AI-only reply mode
* ✅ New-user auto reply
* ✅ Conversation history
* ✅ Custom AI instructions
* ✅ Multiple OpenAI API keys
* ✅ API-key rotation/failover support
* ✅ Configurable AI model
* ✅ Configurable output token limit
* ✅ AI test endpoint

### 🔔 Auto Reply Modes

The project can be configured for different automatic response workflows:

```text
AI MODE
WELCOME MODE
BUSY MODE
OFF
```

Example:

```text
Incoming WhatsApp message
          ↓
     Auto Reply
          ↓
 ┌────────┼────────┐
 ↓        ↓        ↓
 AI     Welcome   Busy
```

### 📢 Bulk Messaging

Bulk messaging can be implemented through the API.

Possible use cases:

* Customer notifications
* Admission notifications
* Order updates
* Appointment reminders
* Business alerts
* Transaction notifications
* Internal communication

> ⚠️ Never use bulk messaging for spam or unsolicited advertising. Only message users where you have an appropriate basis/consent and provide opt-out mechanisms where applicable.

### 👥 Multi Account

Multiple WhatsApp accounts can be managed using separate account IDs.

Example:

```text
user1 → Personal WhatsApp
user2 → Business WhatsApp
user3 → Support WhatsApp
user4 → Sales WhatsApp
```

Each account can maintain its own authentication/session.

---

# 🏗️ Architecture

```text
                  ┌────────────────────┐
                  │ Website / Mobile   │
                  │ App / CRM / Panel  │
                  └─────────┬──────────┘
                            │
                            ▼
                  ┌────────────────────┐
                  │   REST API         │
                  │   Express.js       │
                  └─────────┬──────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
      ┌───────────────┐           ┌───────────────┐
      │ WhatsApp      │           │ OpenAI        │
      │ Connector     │           │ AI            │
      └───────┬───────┘           └───────┬───────┘
              │                           │
              └─────────────┬─────────────┘
                            ▼
                    WhatsApp Account
```

---

# 🛠️ Technology Stack

* Node.js
* Express.js
* JavaScript
* Baileys
* Pino
* QRCode
* CORS
* OpenAI API
* REST API
* Multi-file authentication

Baileys provides the WhatsApp Web connection layer and supports QR and pairing-code authentication.

---

# 📁 Project Structure

Example project structure:

```text
whatsapp-msg-api/
│
├── connector.js
├── package.json
├── package-lock.json
├── .env.example
├── README.md
│
├── auth/
│   ├── user1/
│   ├── user2/
│   └── ...
│
└── logs/
```

### Main files

| File           | Purpose                              |
| -------------- | ------------------------------------ |
| `connector.js` | Main API server                      |
| `package.json` | Node.js dependencies and scripts     |
| `.env.example` | Configuration template               |
| `README.md`    | Documentation                        |
| `auth/`        | WhatsApp authentication/session data |

---

# 💻 Requirements

Recommended:

```text
Node.js 20+
npm
Internet connection
WhatsApp account
```

For AI:

```text
OpenAI API key
```

For cloud deployment:

```text
Railway / VPS / similar Node.js hosting
```

---

# 📥 Installation

Clone the repository:

```bash
git clone YOUR_GITHUB_REPOSITORY_URL
```

Enter the project:

```bash
cd whatsapp-msg-api
```

Install dependencies:

```bash
npm install
```

Create your environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and configure your settings.

---

# ⚙️ Environment Variables

Example:

```env
PORT=3000

AUTO_REPLY_ENABLED=true
AUTO_REPLY_MODE=ai
AI_ACCOUNT=user1

OPENAI_API_KEYS=YOUR_OPENAI_KEY
OPENAI_MODEL=YOUR_MODEL

OPENAI_MAX_OUTPUT_TOKENS=350
AI_HISTORY_LIMIT=12
OPENAI_TIMEOUT_MS=30000

IDLE_TIMEOUT_MS=1800000
```

### Configuration

| Variable                   | Description                  |
| -------------------------- | ---------------------------- |
| `PORT`                     | API server port              |
| `AUTO_REPLY_ENABLED`       | Enable/disable auto reply    |
| `AUTO_REPLY_MODE`          | AI, welcome, busy or off     |
| `AI_ACCOUNT`               | WhatsApp account used for AI |
| `OPENAI_API_KEYS`          | OpenAI API key(s)            |
| `OPENAI_MODEL`             | AI model                     |
| `OPENAI_MAX_OUTPUT_TOKENS` | Maximum generated output     |
| `AI_HISTORY_LIMIT`         | Conversation history size    |
| `OPENAI_TIMEOUT_MS`        | OpenAI request timeout       |
| `IDLE_TIMEOUT_MS`          | Idle/presence timeout        |

---

# 🔐 Multiple OpenAI API Keys

You can configure multiple keys.

Example:

```env
OPENAI_API_KEYS=KEY_1,KEY_2,KEY_3
```

The application can select another configured key when a request fails, depending on the implementation.

### NEVER commit real API keys

Do NOT put this in GitHub:

```text
sk-xxxxxxxxxxxxxxxx
```

Instead use:

```env
OPENAI_API_KEYS=YOUR_KEY_HERE
```

Add `.env` to `.gitignore`:

```gitignore
.env
auth/
node_modules/
logs/
```

---

# 🚀 Start Locally

Run:

```bash
npm start
```

Or:

```bash
node connector.js
```

The server should start on:

```text
http://localhost:3000
```

---

# ❤️ Health Check

```http
GET /health
```

Example:

```bash
curl http://localhost:3000/health
```

Possible response:

```json
{
  "ok": true
}
```

---

# 📊 Status

```http
GET /status
```

This endpoint can be used to check connector/account status.

---

# 📱 QR Connection

The connector can generate a WhatsApp QR code for authentication.

Typical flow:

```text
Start API
   ↓
Create account
   ↓
Generate QR
   ↓
WhatsApp → Linked Devices
   ↓
Scan QR
   ↓
Connected
```

WhatsApp Web clients such as Baileys support QR-based login through WhatsApp's linked-device flow.

---

# 🔢 Pairing Code

The project can also support pairing-code authentication.

Example flow:

```text
Enter phone number
        ↓
Request pairing code
        ↓
Open WhatsApp
        ↓
Linked Devices
        ↓
Link with phone number
        ↓
Connected
```

The phone number should be supplied with the country code in the format expected by the connector. Baileys documents pairing-code authentication as an alternative to QR login.

---

# 🔌 API Endpoints

## Root

```http
GET /
```

Returns basic API information.

---

## Health

```http
GET /health
```

Checks whether the server is running.

---

## Status

```http
GET /status
```

Returns connector/account status.

---

# 🔗 Connect Account

```http
POST /connect
```

Example:

```json
{
  "account": "user1"
}
```

---

# 🔢 Pair Account

```http
POST /pair
```

Example:

```json
{
  "account": "user1",
  "phone": "91XXXXXXXXXX"
}
```

Use the phone number format expected by the connector.

---

# 📱 Get QR

```http
GET /qr
```

The QR endpoint can be used by a frontend/API panel to display the current authentication QR.

---

# ❌ Disconnect

```http
POST /disconnect
```

Example:

```json
{
  "account": "user1"
}
```

---

# ♻️ Reset Account

```http
POST /reset
```

Example:

```json
{
  "account": "user1"
}
```

Use this when you need to clear/reset the account's authentication state.

---

# 💬 Send Message

```http
POST /send-message
```

Example:

```json
{
  "account": "user1",
  "to": "91XXXXXXXXXX",
  "message": "Hello from RB Developments!"
}
```

### Example JavaScript

```javascript
fetch("https://YOUR-API-DOMAIN/send-message", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    account: "user1",
    to: "91XXXXXXXXXX",
    message: "Hello from RB Developments!"
  })
});
```

---

# 📎 Send Media

```http
POST /send-media
```

Use this endpoint to send supported media through the connected WhatsApp account.

Typical use cases:

```text
Image
Document
PDF
Business file
Receipt
Invoice
Certificate
```

The exact request format should follow the implementation in `connector.js`.

---

# 🤖 AI Auto Reply

Enable:

```env
AUTO_REPLY_ENABLED=true
```

Set:

```env
AUTO_REPLY_MODE=ai
```

Set the WhatsApp account:

```env
AI_ACCOUNT=user1
```

Now incoming messages for the configured account can be processed by the AI auto-reply system.

---

# 🧠 AI Message Flow

```text
Customer
   │
   │ WhatsApp message
   ▼
WhatsApp Connector
   │
   ▼
Incoming Message Handler
   │
   ▼
Conversation History
   │
   ▼
OpenAI
   │
   ▼
Generated Response
   │
   ▼
WhatsApp
   │
   ▼
Customer
```

Example:

**Customer:**

```text
Hello
```

**AI:**

```text
Hello! 👋 Welcome to RB Developments.
How can I help you today?
```

---

# 🆕 New User Auto Reply

A new customer can automatically receive an AI-generated response.

Example:

```text
Customer:
Hi, I need a website.
```

AI:

```text
Hello! 👋
Welcome to RB Developments.

We provide website design and development services.
Please tell me what type of website you need.
```

---

# 👋 Welcome Mode

Set:

```env
AUTO_REPLY_MODE=welcome
```

Example response:

```text
Hello! 👋

Welcome to RB Developments.

Thank you for contacting us.
We'll get back to you shortly.
```

---

# ⏰ Busy Mode

Set:

```env
AUTO_REPLY_MODE=busy
```

Example:

```text
Thank you for your message. 🙏

Ripun is currently busy.
He will reply as soon as possible.

Thank you for your patience.
```

---

# 🔕 Disable Auto Reply

Set:

```env
AUTO_REPLY_ENABLED=false
```

Or use the supported configuration/API setting for disabling automatic replies.

---

# 🧪 AI Test

The project can provide an AI test endpoint.

Example:

```http
POST /ai/test
```

Request:

```json
{
  "account": "user1",
  "message": "Hello, what services do you provide?"
}
```

This allows you to test AI generation without sending the test message to a customer.

---

# ⚙️ Auto Reply Settings

The project can expose an auto-reply settings endpoint such as:

```http
GET /auto-reply/settings
```

and:

```http
POST /auto-reply/settings
```

Use the exact request fields implemented in your current `connector.js`.

---

# 🧹 Clear AI History

Conversation history can be cleared using:

```http
POST /auto-reply/clear-history
```

Example:

```json
{
  "account": "user1",
  "phone": "91XXXXXXXXXX"
}
```

This is useful when testing a conversation from the beginning.

---

# 📢 Bulk Messaging

Bulk messaging should be implemented on top of the single-message endpoint.

Example workflow:

```text
contacts.json
      ↓
Read contacts
      ↓
Validate numbers
      ↓
Send message
      ↓
Wait / Rate limit
      ↓
Next contact
```

Example data:

```json
[
  {
    "phone": "91XXXXXXXXXX",
    "name": "User One"
  },
  {
    "phone": "91XXXXXXXXXX",
    "name": "User Two"
  }
]
```

Personalized message:

```text
Hello {name} 👋

Your notification from RB Developments.
```

> ⚠️ Implement rate limiting, consent management and opt-out handling before using this in production.

---

# 🌐 Website Integration

You can integrate this API into:

* PHP websites
* Laravel
* Node.js
* React
* Next.js
* Vue
* Angular
* Flutter
* Android applications
* Desktop applications
* CRM systems
* Billing software
* Admission systems
* E-commerce systems

Example:

```text
Your Website
     ↓
WhatsApp API
     ↓
WhatsApp
```

---

# 📱 Mobile App Integration

Your Android/iOS/Flutter application can call the REST API.

Example:

```text
Flutter App
     ↓
POST /send-message
     ↓
WhatsApp API
     ↓
WhatsApp Customer
```

---

# 🧾 Example: Website Notification

Your PHP website receives an order:

```text
New Order
    ↓
PHP Backend
    ↓
WhatsApp API
    ↓
Customer receives:
"Your order has been received!"
```

---

# 🎓 Example: Admission System

This API can also be integrated into an admission system.

Example:

```text
Student Admission
       ↓
Database
       ↓
WhatsApp API
       ↓
Student receives
Login Details / Admission Confirmation
```

---

# ☁️ Railway Deployment

Railway can deploy Node.js services directly from GitHub.

## Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial WhatsApp API"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

---

## Step 2 — Open Railway

Create a Railway project.

Choose:

```text
New Project
        ↓
Deploy from GitHub Repo
        ↓
Select Repository
```

Railway documents GitHub-based deployment as a standard deployment path.

---

## Step 3 — Add Variables

Open:

```text
Service
   ↓
Variables
```

Add:

```env
PORT=3000
AUTO_REPLY_ENABLED=true
AUTO_REPLY_MODE=ai
AI_ACCOUNT=user1
OPENAI_API_KEYS=YOUR_KEY
OPENAI_MODEL=YOUR_MODEL
```

Railway service variables are exposed to the running application as environment variables and are intended for configuration/secrets.

---

## Step 4 — Deploy

Click:

```text
Deploy
```

Wait for the build to finish.

---

## Step 5 — Generate Domain

Create a public domain for your service.

Example:

```text
https://your-project.up.railway.app
```

Then test:

```text
https://your-project.up.railway.app/health
```

---

# 🔐 Production Security

Before putting this API into production, add authentication.

For example:

```http
Authorization: Bearer YOUR_API_TOKEN
```

or:

```http
X-API-Key: YOUR_API_KEY
```

Recommended protections:

* API authentication
* Rate limiting
* Request validation
* CORS restrictions
* HTTPS
* Logging
* Abuse protection
* Input validation
* Secret management
* Account access control

---

# 🔒 Never Expose Secrets

Never upload:

```text
.env
OpenAI API keys
WhatsApp session files
Authentication credentials
Private tokens
```

to GitHub.

Recommended `.gitignore`:

```gitignore
node_modules/
.env
.env.*
!.env.example
auth/
sessions/
logs/
*.log
```

---

# 🛡️ WhatsApp Session Security

Authentication/session files can contain sensitive credentials.

Do not:

* Share your `auth/` directory publicly
* Upload session files to GitHub
* Send session files to strangers
* Include sessions in YouTube downloads

If a session is compromised, disconnect the device/account and create a fresh authentication session.

---

# 🐛 Troubleshooting

## QR is not appearing

Check:

```text
Node.js version
npm install
PORT
account ID
logs
internet connection
```

Restart the application.

---

## WhatsApp disconnects

Check the server logs.

Possible causes include:

```text
Network interruption
Authentication/session issue
Library compatibility
WhatsApp-side changes
Server restart
```

Baileys-based clients should implement reconnect handling and persistent credential storage for production use.

---

## AI is not replying

Check:

```text
AUTO_REPLY_ENABLED=true
AUTO_REPLY_MODE=ai
AI_ACCOUNT=user1
OPENAI_API_KEYS=...
```

Also check:

```text
OpenAI API access
Model configuration
API logs
Network connection
```

---

## Railway deployment fails

Check:

```text
package.json
Node.js version
start script
environment variables
deployment logs
```

Railway provides deployment/build logs and supports automatic redeployment from GitHub changes.

---

# 📈 Production Recommendations

For a serious production deployment, consider adding:

* Redis
* PostgreSQL
* External session storage
* Queue system
* Message retry system
* Rate limiter
* Admin authentication
* API keys per customer
* Usage analytics
* Message logs
* Webhooks
* Contact management
* Campaign management
* Opt-out management
* Dashboard
* Role-based access
* Monitoring
* Backup system

For persistent production workloads, Railway supports long-running services and configurable variables/secrets.

---

# 🧩 Possible Future Features

Planned/possible features:

* [ ] Webhook system
* [ ] Admin dashboard
* [ ] API-key management
* [ ] Customer management
* [ ] Message history
* [ ] Campaign manager
* [ ] Scheduled messages
* [ ] Contact import
* [ ] CSV bulk sender
* [ ] Delivery statistics
* [ ] AI prompt manager
* [ ] Multiple AI providers
* [ ] Chat history database
* [ ] PostgreSQL support
* [ ] Redis queue
* [ ] Role-based admin
* [ ] WebSocket live status
* [ ] Advanced analytics

---

# 📚 API Quick Reference

| Method     | Endpoint                    | Purpose             |
| ---------- | --------------------------- | ------------------- |
| `GET`      | `/`                         | API information     |
| `GET`      | `/health`                   | Health check        |
| `GET`      | `/status`                   | Account/status      |
| `GET`      | `/qr`                       | QR information      |
| `POST`     | `/connect`                  | Connect account     |
| `POST`     | `/pair`                     | Pair account        |
| `POST`     | `/disconnect`               | Disconnect account  |
| `POST`     | `/reset`                    | Reset account       |
| `POST`     | `/send-message`             | Send text           |
| `POST`     | `/send-media`               | Send media          |
| `POST`     | `/ai/test`                  | Test AI             |
| `GET/POST` | `/auto-reply/settings`      | Auto-reply settings |
| `POST`     | `/auto-reply/clear-history` | Clear AI history    |

> Endpoint availability and exact request/response formats depend on the current implementation in `connector.js`.

---

# 🧪 Example API Request

```javascript
const response = await fetch(
  "https://YOUR-API-DOMAIN/send-message",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": "YOUR_API_KEY"
    },
    body: JSON.stringify({
      account: "user1",
      to: "91XXXXXXXXXX",
      message: "Hello from RB Developments!"
    })
  }
);

const result = await response.json();

console.log(result);
```

---

# 🎯 Use Cases

This project can be used for:

### 🏢 Business

* Customer support
* Lead notifications
* Business alerts
* Order updates

### 🛒 E-commerce

* Order confirmation
* Shipping notifications
* Delivery updates
* Customer support

### 🎓 Education

* Admission confirmation
* Student notifications
* Course updates
* Login information

### 💻 Developers

* API integrations
* Web applications
* Mobile apps
* CRM systems

### 🤖 AI

* AI customer support
* AI assistant
* Automated FAQ
* Lead qualification

---

# ⚠️ Responsible Use

This project is intended for legitimate development and automation.

Do not use it for:

* Spam
* Harassment
* Fraud
* Phishing
* Unauthorized messaging
* Mass unsolicited advertising
* Circumventing platform restrictions

Always respect:

* WhatsApp rules/policies
* Recipient consent
* Applicable privacy laws
* Local regulations
* Opt-out requests

---

# 📜 Disclaimer

This project is provided for educational and development purposes.

**RB Developments and Ripun Baruah are not affiliated with or endorsed by WhatsApp or Meta.**

WhatsApp is a trademark of Meta Platforms, Inc.

The project communicates through a WhatsApp Web-compatible client library and is not the official WhatsApp Cloud API.

Platform behavior, authentication, limits and compatibility may change over time.

---

# 👨‍💻 Developer

## RB Developments

**Ripun Baruah**

Web Designer • Developer • AI • API • Automation

### Services

* Website Design
* Web Development
* PHP Development
* Node.js Development
* API Development
* AI Integration
* Automation
* Custom Software

---

# ⭐ Support the Project

If this project helped you:

⭐ Star the repository

🍴 Fork the repository

🐛 Report issues

💡 Suggest features

📢 Share it with other developers

---

# 🔗 Links

### GitHub

**[GITHUB_REPOSITORY_LINK](https://github.com/Ripun-web/wa-connector)**

### Railway

[**RAILWAY_LINK**](https://railway.com/)

### API Panel Download

**6002322737**

### RB Developments

[**RB_DEVELOPMENTS_WEBSITE**](https://rb-online.in/)

---

# ❤️ Credits

Built with:

* Node.js
* Express.js
* Baileys
* OpenAI
* QRCode
* Pino

Special thanks to the open-source developer community.

---

## 🚀 Built by RB Developments

### **Code • AI • Web • Automation**

**Ripun Baruah**

> Build something useful. Build something better. 🚀
