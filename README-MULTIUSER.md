# Multi-user deployment addendum

1. Set Railway start command to `node gateway.js` (the included railway.json does this).
2. Attach a Railway Volume mounted at `/data`; set `DATA_DIR=/data`. This is required to retain each user's WhatsApp auth state across redeploys.
3. Set `TENANT_SECRET` to a cryptographically random secret (at least 32 random bytes, hex encoded). Copy exactly the same value to `WA_TENANT_SECRET` in the PHP `config.php`. Never commit either secret.
4. Set `CONNECTOR_API_TOKEN` to a separate random secret. The gateway passes this only to internal worker processes.
5. Deploy. Check `/health`. PHP `connector_url` must point to this public gateway.

Each verified token selects a tenant ID and launches a connector worker with its own `AUTH_DIR` and `DATA_DIR`. A user token is `wa_<user-id>.<nonce>.<subscription-expiry-unix>.<HMAC-SHA256>`. Rotating `token_nonce` revokes the previous token.

Important deployment note: Railway service containers normally expose only the configured public port. This gateway starts per-user workers on local ports and proxies traffic internally; workers bind to the host default in connector.js, so ensure Railway's networking policy allows local worker ports. If the runtime cannot bind workers to loopback/local ports, adapt connector.js to bind `HOST=127.0.0.1` (this build sets HOST in worker environment, but connector.js must honor it). Persistent volume capacity and resource limits must support concurrent workers.
