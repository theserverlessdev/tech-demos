# Setup — temp-email

This file lists what is live, what the owner must still do, and how the agent API works.

- **UI and API:** <https://test-email.theserverless.dev>
- **Addresses:** `anything@test-email.theserverless.dev`
- **Worker:** `tech-demos-temp-email`
- **D1 database:** `tech-demos-temp-email` (`c41b5408-e3fd-44d4-9455-f355016b483b`)
- **Zone:** `theserverless.dev` (`e60a45645a0c2f830636bfe7c121ca86`)

## Status on 2026-09-11

| Item | State | Who did it |
| --- | --- | --- |
| D1 database and migration `0001_init.sql` | Done | Agent |
| Worker deploy with a cron job every 15 minutes | Done | Agent |
| Custom domain `test-email.theserverless.dev` | Done | Agent |
| Hub routes `tech-demos.theserverless.dev/demos/temp-email*` and `temp-email.tech-demos.theserverless.dev/*` | Done. Both send a 302 to the custom domain. | Agent |
| Secret `AGENT_API_KEY` | Done. The value is in `demos/temp-email/.secrets/agent-api-key` on the build machine. Git ignores that file. | Agent |
| Email Routing catch-all rule → Worker `tech-demos-temp-email` | Done through the REST API. Wrangler 4.129 blocks the `worker` action for a catch-all, but the API accepts it. | Agent |
| Email Routing for the subdomain `test-email.theserverless.dev` (MX and SPF) | **Not done** | **Owner** |
| Apex `theserverless.dev` MX records | Unchanged. They point at Google Workspace. | Nobody |

## Why the agent stopped before MX

Apex mail for `theserverless.dev` goes to Google Workspace. The demo must not change that.

1. `wrangler email routing enable <domain>` sends `POST /zones/{zone}/email/routing/enable`. That call is for the whole zone. It does not take a subdomain.
2. `wrangler email routing dns get theserverless.dev` shows the records that the zone-level call adds. They are MX records on the **apex**:

   ```text
   theserverless.dev  MX  2   route1.mx.cloudflare.net.
   theserverless.dev  MX  43  route2.mx.cloudflare.net.
   theserverless.dev  MX  25  route3.mx.cloudflare.net.
   theserverless.dev  TXT "v=spf1 include:_spf.mx.cloudflare.net ~all"
   ```

   Those records would take apex mail away from Google. The agent did not run the command.
3. Wrangler has no command that adds the records to a subdomain only. The agent's token has `zone (read)` only, so it cannot write DNS records.
4. A read-only call gives the records that the subdomain needs. The records are on `test-email` only:

   ```bash
   curl -s -H "Authorization: Bearer $CF_TOKEN" \
     "https://api.cloudflare.com/client/v4/zones/e60a45645a0c2f830636bfe7c121ca86/email/routing/dns?subdomain=test-email.theserverless.dev"
   ```

   ```text
   test-email.theserverless.dev  MX  2   route1.mx.cloudflare.net.
   test-email.theserverless.dev  MX  43  route2.mx.cloudflare.net.
   test-email.theserverless.dev  MX  25  route3.mx.cloudflare.net.
   test-email.theserverless.dev  TXT "v=spf1 include:_spf.mx.cloudflare.net ~all"
   ```

## What the owner must do

### Step 0: record the apex MX before you start

```bash
dig +short MX theserverless.dev
```

The output on 2026-09-11 was:

```text
1 aspmx.l.google.com.
5 alt1.aspmx.l.google.com.
5 alt2.aspmx.l.google.com.
10 alt3.aspmx.l.google.com.
10 alt4.aspmx.l.google.com.
```

### Step 1: add the subdomain to Email Routing (dashboard)

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com/3f847e2fadeef3e583701e8fa25657b5/theserverless.dev) and select the zone `theserverless.dev`.
2. Go to **Compute** > **Email Service** > **Email Routing**.
3. Open **Settings**.
4. Under **Subdomains**, type `test-email` and submit.
5. Accept the records for `test-email.theserverless.dev` only. The list must match the subdomain records above.

> **Stop if the dashboard shows the apex onboarding wizard.** Some zones show "Get started" or "Add records and enable" before the Settings tab. That wizard adds MX records on `theserverless.dev` and offers to delete the Google records. Do not accept it. Go to Step 1b.

### Step 1b: use the API if the dashboard forces the apex wizard

This endpoint adds the Email Routing DNS records for a zone. Cloudflare documents the `name` field only as "Domain of your zone". The agent did not run this call, because Cloudflare does not document its effect on the apex. Run Step 0 again right after the call.

```bash
CF_TOKEN=…   # a token with Email Routing: Edit and DNS: Edit on theserverless.dev
curl -s -X POST \
  -H "Authorization: Bearer $CF_TOKEN" -H "content-type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/e60a45645a0c2f830636bfe7c121ca86/email/routing/dns" \
  -d '{"name": "test-email.theserverless.dev"}'
dig +short MX theserverless.dev   # must still list only Google
```

Remove the apex Cloudflare MX records at once if the call adds them. The rollback section gives the steps.

### Step 2: check the records

Wait one or two minutes, then run the commands below.

```bash
dig +short MX test-email.theserverless.dev   # route1, route2, route3 .mx.cloudflare.net
dig +short TXT test-email.theserverless.dev  # v=spf1 include:_spf.mx.cloudflare.net ~all
dig +short MX theserverless.dev              # still Google only
curl -s https://test-email.theserverless.dev/api/v1/config | jq .mx
```

The Worker reads MX through DNS over HTTPS and keeps the result for 5 minutes. After that, the yellow strip in the UI turns green.

### Step 3: send a real message

1. Open <https://test-email.theserverless.dev> and press **New address**.
2. Start a log stream: `cd demos/temp-email && bunx wrangler tail tech-demos-temp-email`.
3. From Gmail, send a message to the new address.
4. The message shows in the UI within 5 seconds. The log shows `{"event":"email","outcome":"stored",…}`.

Use the table to find a fault.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Gmail bounces with "No active inbox has this address" | The Worker works. The address expired or has a typo. | Mint a new address. |
| Gmail bounces with "accepts mail for @test-email.theserverless.dev only" | Mail for another domain reached the Worker. | Check the routing rules. |
| No bounce, no log line, no message | Email Routing did not send the message to the Worker. | Open **Email Routing** > **Routing rules**. Check that the catch-all for `test-email.theserverless.dev` is enabled and sends to the Worker `tech-demos-temp-email`. |
| The Gmail bounce names the DNS or the MX | The subdomain records are missing. | Do Step 1 again. |

The catch-all rule applies to the zone. The Cloudflare docs do not say how it applies to a subdomain. If the dashboard shows a separate catch-all for the subdomain, set that catch-all to **Send to a Worker** > `tech-demos-temp-email`.

## Rollback

```bash
# 1. Remove the subdomain: dashboard > Email Routing > Settings > Subdomains > remove test-email.
# 2. Set the catch-all back to disabled and drop.
bunx wrangler email routing rules update theserverless.dev catch-all --action-type drop --enabled false
# 3. Remove the Worker, its custom domain, its routes, and the database.
cd demos/temp-email
bunx wrangler delete tech-demos-temp-email
bunx wrangler d1 delete tech-demos-temp-email
```

## Agent API

The browser and agents use one API: `https://test-email.theserverless.dev/api/v1`. Each call sends a bearer token.

- **Agent key:** the `AGENT_API_KEY` secret. It opens every inbox. It can set a TTL of up to 1440 minutes and can deliver raw MIME.
- **Inbox token:** the create call returns it once. It opens only its own inbox. The server keeps only its SHA-256 hash.

Rate limits apply to callers without the agent key: 6 creates or samples each minute and 90 API calls each minute for each IP address.

### Endpoints

`{address}` is `name@test-email.theserverless.dev` or `name`. The server drops a `+tag`.

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
BASE=https://test-email.theserverless.dev/api/v1
KEY=$(cat demos/temp-email/.secrets/agent-api-key)

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
AGENT_API_KEY=$(cat .secrets/agent-api-key) bun run smoke -- https://test-email.theserverless.dev
```
