# Setup — temp-email

This file lists what is live and how the agent API works.

- **UI and API:** <https://email.lomvic.com>
- **Addresses:** `anything@email.lomvic.com`
- **Worker:** `tech-demos-temp-email`
- **D1 database:** `tech-demos-temp-email` (`c41b5408-e3fd-44d4-9455-f355016b483b`)
- **Mail zone:** `lomvic.com` (`7b0cbb059730070dc5e85f1fd9a46f28`) — throwaway mail zone
- **Hub zone:** `theserverless.dev` — gallery + redirect routes only; apex MX stays on Google Workspace

## Status on 2026-09-11

| Item | State | Who did it |
| --- | --- | --- |
| D1 database and migration `0001_init.sql` | Done | Agent |
| Worker deploy with a cron job every 15 minutes | Done | Agent |
| Custom domain `email.lomvic.com` | Done | Agent |
| Hub routes `tech-demos.theserverless.dev/demos/temp-email*` and `temp-email.tech-demos.theserverless.dev/*` | Done. Both send a 302 to `https://email.lomvic.com`. | Agent |
| Secret `AGENT_API_KEY` | Done. Local copy lives in `~/.theserverlessdev/temp-email.env` (and optionally `demos/temp-email/.secrets/agent-api-key` on a build machine). Git ignores secret files. | Agent |
| Email Routing enabled on `lomvic.com` | Done | Owner |
| Subdomain / custom hostname mail for `email.lomvic.com` (MX + SPF) | Done | Owner |
| Catch-all / `*@email.lomvic.com` → Worker `tech-demos-temp-email` | Done | Owner |
| Apex `theserverless.dev` MX records | Unchanged. They point at Google Workspace. Do not enable Email Routing on TSD for this demo. | Nobody |

> **Note:** Disposable mail previously targeted `test-email.theserverless.dev`. It moved to `email.lomvic.com` so TSD apex Google MX never needs Email Routing. Old TSD custom domain and catch-all for that subdomain are removed / disabled.

## Mail zone (lomvic.com)

Inbound demo mail uses Cloudflare Email Routing on zone `lomvic.com` (`7b0cbb059730070dc5e85f1fd9a46f28`):

- Email Routing is enabled for the zone.
- MX and SPF live on the subdomain `email.lomvic.com` (not on `theserverless.dev`).
- Routing rule: catch-all and/or `*@email.lomvic.com` → Worker `tech-demos-temp-email`.
- Worker custom domain: `email.lomvic.com`.

Expected DNS:

```text
email.lomvic.com  MX   route1.mx.cloudflare.net.
email.lomvic.com  MX   route2.mx.cloudflare.net.
email.lomvic.com  MX   route3.mx.cloudflare.net.
email.lomvic.com  TXT  "v=spf1 include:_spf.mx.cloudflare.net ~all"
```

### Verify

```bash
dig +short MX email.lomvic.com   # route*.mx.cloudflare.net
dig +short TXT email.lomvic.com  # v=spf1 include:_spf.mx.cloudflare.net ~all
dig +short MX theserverless.dev  # still Google only — never change this for the demo
curl -s https://email.lomvic.com/api/v1/config | jq .
```

The Worker reads MX through DNS over HTTPS and caches the result for 5 minutes. After that, the yellow strip in the UI turns green when MX is healthy.

### Send a real message

1. Open <https://email.lomvic.com> and press **New address**.
2. Start a log stream: `cd demos/temp-email && bunx wrangler tail tech-demos-temp-email`.
3. From Gmail, send a message to the new address.
4. The message shows in the UI within 5 seconds. The log shows `{"event":"email","outcome":"stored",…}`.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Gmail bounces with "No active inbox has this address" | The Worker works. The address expired or has a typo. | Mint a new address. |
| Gmail bounces with "accepts mail for @email.lomvic.com only" | Mail for another domain reached the Worker. | Check the routing rules and `MAIL_DOMAIN`. |
| No bounce, no log line, no message | Email Routing did not send the message to the Worker. | Open **Email Routing** > **Routing rules** on `lomvic.com`. Check catch-all / `*@email.lomvic.com` → `tech-demos-temp-email`. |
| The Gmail bounce names the DNS or the MX | The subdomain records are missing. | Confirm MX/SPF on `email.lomvic.com` in the lomvic zone. |

## Rollback

```bash
# 1. On lomvic.com: disable catch-all / Worker routing for *@email.lomvic.com (or set drop).
# 2. Remove the Worker custom domain email.lomvic.com, hub routes, and optionally the Worker + D1.
cd demos/temp-email
bunx wrangler delete tech-demos-temp-email
bunx wrangler d1 delete tech-demos-temp-email
```

Do **not** enable Email Routing on `theserverless.dev` and do **not** change TSD apex Google MX as part of rollback or redeploy.

## Agent API

The browser and agents use one API: `https://email.lomvic.com/api/v1`. Each call sends a bearer token.

- **Agent key:** the `AGENT_API_KEY` secret. It opens every inbox. It can set a TTL of up to 1440 minutes and can deliver raw MIME.
- **Inbox token:** the create call returns it once. It opens only its own inbox. The server keeps only its SHA-256 hash.

Rate limits apply to callers without the agent key: 6 creates or samples each minute and 90 API calls each minute for each IP address.

### Endpoints

`{address}` is `name@email.lomvic.com` or `name`. The server drops a `+tag`.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /config` | none | Domain, limits, and live MX status. No token is necessary. |
| `POST /inboxes` | `{"localPart"?: "my-test", "ttlMinutes"?: 30}` | `201` with the inbox and its `token`. `ttlMinutes` needs the agent key. `409` if the name is in use. |
| `GET /inboxes/{address}` | none | The inbox with `expiresAt` and `messageCount`. |
| `DELETE /inboxes/{address}` | none | Deletes the inbox and its messages. |
| `POST /inboxes/{address}/extend` | `{"minutes"?: 60}` | Moves the expiry later. The limit is now + 1440 minutes. |
| `GET /inboxes/{address}/messages?after=0&limit=50` | none | Summaries, newest first, and a `cursor`. |
| `GET /inboxes/{address}/wait?after={cursor}&timeout=25` | none | Long poll. It returns full messages with `seq` above `after`, oldest first. It returns `timedOut: true` after `timeout` seconds (25 or fewer) with no mail. |
| `GET /inboxes/{address}/messages/{id}` | none | The full message: `text`, `html`, `codes`, `links`, and `attachments` (metadata only). |
| `DELETE /inboxes/{address}/messages/{id}` | none | Deletes one message. |
| `POST /inboxes/{address}/sample` | none | Stores a server-built sign-up message through the real parser. `via` is `sample`. |
| `POST /inboxes/{address}/deliver` | raw MIME (`message/rfc822`) | Agent key only. Stores the MIME through the real parser. `via` is `test`. The optional `X-Envelope-From` header sets the envelope sender. |

Errors use the shape `{"error": {"code": "not_found", "message": "…"}}`. A wrong token and an unknown address both return `404`.

### Example: sign up and read the code

```bash
BASE=https://email.lomvic.com/api/v1
# Prefer ~/.theserverlessdev/temp-email.env (TEMP_EMAIL_API_KEY) or demos/temp-email/.secrets/agent-api-key
KEY=$(grep -E '^TEMP_EMAIL_API_KEY=' ~/.theserverlessdev/temp-email.env | cut -d= -f2-)

# 1. Create an inbox for 30 minutes.
INBOX=$(curl -s -X POST "$BASE/inboxes" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"ttlMinutes": 30}')
ADDRESS=$(echo "$INBOX" | jq -r .address)
echo "Sign up with $ADDRESS"

# 2. Wait for mail. Repeat with the returned cursor until a message arrives.
CURSOR=0
while :; do
  RESULT=$(curl -s "$BASE/inboxes/$ADDRESS/wait?after=$CURSOR&timeout=25" -H "Authorization: Bearer $KEY")
  CURSOR=$(echo "$RESULT" | jq .cursor)
  if [ "$(echo "$RESULT" | jq .timedOut)" = "false" ]; then break; fi
done

# 3. Read the code and the links.
echo "$RESULT" | jq '.messages[0] | {subject, codes, links}'

# 4. Delete the inbox.
curl -s -X DELETE "$BASE/inboxes/$ADDRESS" -H "Authorization: Bearer $KEY"
```

`codes` holds up to 5 numbers of 4 to 8 digits. Each one is near a word such as "code", "verify", or "login", or stands alone on a line. Treat `codes` as a hint and check the text when the result matters.

### Test without MX

```bash
curl -s -X POST "$BASE/inboxes/$ADDRESS/deliver" \
  -H "Authorization: Bearer $KEY" -H "X-Envelope-From: bounce@example.com" \
  --data-binary $'From: Test <test@example.com>\r\nTo: '"$ADDRESS"$'\r\nSubject: Code\r\nMessage-ID: <1@example.com>\r\n\r\nYour code is 482913\r\n'
```

### Rotate the agent key

```bash
cd demos/temp-email
openssl rand -hex 32 > .secrets/agent-api-key
tr -d '\n' < .secrets/agent-api-key | bunx wrangler secret put AGENT_API_KEY
# Also refresh ~/.theserverlessdev/temp-email.env if you keep a local copy there.
```

## Local development

```bash
cd demos/temp-email
echo 'AGENT_API_KEY=dev-agent-key-change-me' > .dev.vars
bun run dev                       # builds the client, applies migrations locally, starts wrangler dev
bun run smoke -- --smtp           # 37 checks; --smtp posts to /cdn-cgi/handler/email to run the real email() handler
```

Wrangler dev can stop with `Network connection lost` when a file changes during a poll request. Start it again.

## Deploy

```bash
cd demos/temp-email
bun run deploy                    # build, remote migrations, wrangler deploy
# smoke against the live origin (key from env file — do not echo it)
set -a && source ~/.theserverlessdev/temp-email.env && set +a
AGENT_API_KEY="$TEMP_EMAIL_API_KEY" bun run smoke -- https://email.lomvic.com
```
