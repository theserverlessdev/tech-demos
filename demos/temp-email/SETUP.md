# Setup — temp-email

Two products share this folder. Do not mix them.

| | Hosted demo | Self-host (your Cloudflare) |
| --- | --- | --- |
| Who | Owner (Ankur), public visitors | You |
| Origin | <https://email.lomvic.com> | Your Worker |
| Mail | `@email.lomvic.com` on zone `lomvic.com` | Your domain; you attach MX |
| Agent API | Turnstile-minted per-agent keys | Your Turnstile + your admin secret |
| Admin secret | `AGENT_API_KEY` — **fleet/internal only** | You set it. Not a public shared key. |

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/theserverlessdev/tech-demos/tree/main/demos/temp-email)

---

## Hosted (email.lomvic.com)

- **UI and API:** <https://email.lomvic.com>
- **Addresses:** `anything@email.lomvic.com`
- **Worker:** `tech-demos-temp-email`
- **D1 database:** `tech-demos-temp-email` (`c41b5408-e3fd-44d4-9455-f355016b483b`)
- **Mail zone:** `lomvic.com` (`7b0cbb059730070dc5e85f1fd9a46f28`) — throwaway mail zone
- **Hub zone:** `theserverless.dev` — gallery + redirect routes only; apex MX stays on Google Workspace

### Status on 2026-09-11

| Item | State | Who did it |
| --- | --- | --- |
| D1 database and migration `0001_init.sql` | Done | Agent |
| Migration `0002_api_keys.sql` | This PR | Agent |
| Worker deploy with a cron job every 15 minutes | Done | Agent |
| Custom domain `email.lomvic.com` | Done | Agent |
| Hub routes `tech-demos.theserverless.dev/demos/temp-email*` and `temp-email.tech-demos.theserverless.dev/*` | Done. Both send a 302 to `https://email.lomvic.com`. | Agent |
| Secret `AGENT_API_KEY` | Done. **Admin/fleet only.** Local copy lives in `~/.theserverlessdev/temp-email.env` (do not print it). Git ignores secret files. | Agent |
| Secrets `TURNSTILE_SITE_KEY` (var) + `TURNSTILE_SECRET_KEY` | Widget create needs `wrangler login` (scope `challenge-widgets.write`). Until set, hosted mint stays off (`503 mint_disabled`). | Owner |
| Email Routing enabled on `lomvic.com` | Done | Owner |
| Subdomain / custom hostname mail for `email.lomvic.com` (MX + SPF) | Done | Owner |
| Catch-all / `*@email.lomvic.com` → Worker `tech-demos-temp-email` | Done | Owner |
| Apex `theserverless.dev` MX records | Unchanged. They point at Google Workspace. Do not enable Email Routing on TSD for this demo. | Nobody |

> **Note:** Disposable mail previously targeted `test-email.theserverless.dev`. It moved to `email.lomvic.com` so TSD apex Google MX never needs Email Routing.

### Mail zone (lomvic.com)

Inbound demo mail uses Cloudflare Email Routing on zone `lomvic.com`:

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
curl -s https://email.lomvic.com/api/v1/config | jq '{domain, hosted, mint}'
```

### Hosted Turnstile (owner)

Wrangler’s current OAuth token may lack `challenge-widgets.write`. Refresh it, then create a managed widget for `email.lomvic.com`. Do not print the secret.

```bash
cd demos/temp-email
bunx wrangler login   # approve challenge-widgets.write
bunx wrangler turnstile widget create "email-lomvic-temp-email" \
  --domain email.lomvic.com --mode managed --json
# Put TURNSTILE_SITE_KEY in wrangler.jsonc vars (public).
# Pipe the widget secret into:
#   bunx wrangler secret put TURNSTILE_SECRET_KEY
bun run deploy
```

Until those are set, `POST /api/v1/keys` returns `503 mint_disabled`. The admin `AGENT_API_KEY` still works for fleet. Anonymous agent API stays closed.

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

### Rollback

```bash
# 1. On lomvic.com: disable catch-all / Worker routing for *@email.lomvic.com (or set drop).
# 2. Remove the Worker custom domain email.lomvic.com, hub routes, and optionally the Worker + D1.
cd demos/temp-email
bunx wrangler delete tech-demos-temp-email
bunx wrangler d1 delete tech-demos-temp-email
```

Do **not** enable Email Routing on `theserverless.dev` and do **not** change TSD apex Google MX as part of rollback or redeploy.

---

## Self-host (your zone)

Owner rules do not apply to your instance. You get the full product: Email Worker, D1, agent API, optional Turnstile mint.

1. Click **Deploy to Cloudflare** in the README, or copy this directory and `bun run deploy:selfhost` with `wrangler.selfhost.jsonc`.
2. Set vars: `MAIL_DOMAIN`, `PUBLIC_ORIGIN`, `HOSTED_MODE=false`, `TURNSTILE_SITE_KEY`.
3. Set secrets (do not echo them):

```bash
openssl rand -hex 32 | bunx wrangler secret put AGENT_API_KEY -c wrangler.selfhost.jsonc
bunx wrangler secret put TURNSTILE_SECRET_KEY -c wrangler.selfhost.jsonc
```

4. Create a [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/) for your UI hostname (or `wrangler turnstile widget create`).
5. Enable **Email Routing** on **your** zone. Point MX at `route*.mx.cloudflare.net`. Catch-all `*@MAIL_DOMAIN` → this Worker.
6. Attach a custom domain if you want. Do not use `theserverless.dev` or `email.lomvic.com`.

If Turnstile is unset, key mint stays off and agents use **your** admin secret only.

---

## Agent API

Base: `https://email.lomvic.com/api/v1` (or your origin). Every inbox call sends a bearer token.

| Token | Who | Powers |
| --- | --- | --- |
| Inbox token | Browser, returned once at create | That inbox only. Web TTL. |
| Minted key (`te1_…`) | Agent, after Turnstile | Inboxes **that key created**. `ttlMinutes`, `wait`, `deliver`. Quota + revoke. |
| `AGENT_API_KEY` | **Admin / fleet only** | Every inbox, no quota. Not the public path. |

Hosted visitors must mint a key. Do not hand out the admin secret.

Rate limits apply to callers without the admin key: 6 creates or samples each minute and 90 API calls each minute (per IP or per minted key). Minted keys also have 10 active inboxes and 40 creates per 24 hours.

### Endpoints

`{address}` is `name@email.lomvic.com` or `name`. The server drops a `+tag`.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /config` | none | Domain, limits, MX, `hosted`, `mint` (Turnstile site key if mint is on). No token. |
| `POST /keys` | `{"name"?: "my-agent", "turnstileToken": "…"}` | `201` with `{ id, name, key, … }`. `key` is shown once. |
| `GET /keys/me` | minted key | Quota and last used. |
| `POST /keys/revoke` | minted key | `{ revoked: true }`. |
| `POST /inboxes` | `{"localPart"?: "my-test", "ttlMinutes"?: 30}` | `201` with the inbox and its `token`. `ttlMinutes` needs an API key. `409` if the name is in use. |
| `GET /inboxes/{address}` | none | The inbox with `expiresAt` and `messageCount`. |
| `DELETE /inboxes/{address}` | none | Deletes the inbox and its messages. |
| `POST /inboxes/{address}/extend` | `{"minutes"?: 60}` | Moves the expiry later. The limit is now + 1440 minutes. |
| `GET /inboxes/{address}/messages?after=0&limit=50` | none | Summaries, newest first, and a `cursor`. |
| `GET /inboxes/{address}/wait?after={cursor}&timeout=25` | none | Long poll. Full messages with `seq` above `after`, oldest first. `timedOut: true` after `timeout` seconds (25 or fewer) with no mail. |
| `GET /inboxes/{address}/messages/{id}` | none | Full message: `text`, `html`, `codes`, `links`, `attachments` (metadata only). |
| `DELETE /inboxes/{address}/messages/{id}` | none | Deletes one message. |
| `POST /inboxes/{address}/sample` | none | Stores a server-built sign-up message. `via` is `sample`. |
| `POST /inboxes/{address}/deliver` | raw MIME (`message/rfc822`) | API key only. `via` is `test`. Optional `X-Envelope-From`. |

Errors use `{"error": {"code": "not_found", "message": "…"}}`. A wrong token and an unknown address both return `404`.

### Fleet / owner (admin key)

Owner agents may keep using `~/.theserverlessdev/temp-email.env` (`TEMP_EMAIL_API_KEY`). That value is the **admin** bootstrap secret. Do not print it. Do not publish it as the demo’s agent key.

```bash
BASE=https://email.lomvic.com/api/v1
# Admin key from the env file — do not echo it
set -a && source ~/.theserverlessdev/temp-email.env && set +a
KEY="$TEMP_EMAIL_API_KEY"

INBOX=$(curl -s -X POST "$BASE/inboxes" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"ttlMinutes": 30}')
ADDRESS=$(echo "$INBOX" | jq -r .address)
echo "Sign up with $ADDRESS"

CURSOR=0
while :; do
  RESULT=$(curl -s "$BASE/inboxes/$ADDRESS/wait?after=$CURSOR&timeout=25" -H "Authorization: Bearer $KEY")
  CURSOR=$(echo "$RESULT" | jq .cursor)
  if [ "$(echo "$RESULT" | jq .timedOut)" = "false" ]; then break; fi
done

echo "$RESULT" | jq '.messages[0] | {subject, codes, links}'
curl -s -X DELETE "$BASE/inboxes/$ADDRESS" -H "Authorization: Bearer $KEY"
```

Public agents should mint a key in the UI (or `POST /keys` with a Turnstile token) and use that Bearer value instead of `TEMP_EMAIL_API_KEY`.

`codes` holds up to 5 numbers of 4 to 8 digits. Treat `codes` as a hint and check the text when the result matters.

### Test without MX

```bash
curl -s -X POST "$BASE/inboxes/$ADDRESS/deliver" \
  -H "Authorization: Bearer $KEY" -H "X-Envelope-From: bounce@example.com" \
  --data-binary $'From: Test <test@example.com>\r\nTo: '"$ADDRESS"$'\r\nSubject: Code\r\nMessage-ID: <1@example.com>\r\n\r\nYour code is 482913\r\n'
```

### Rotate the admin key

```bash
cd demos/temp-email
openssl rand -hex 32 > .secrets/agent-api-key
tr -d '\n' < .secrets/agent-api-key | bunx wrangler secret put AGENT_API_KEY
# Also refresh ~/.theserverlessdev/temp-email.env if you keep a local copy there.
```

Minted keys are not rotated this way — revoke and mint again.

---

## Local development

```bash
cd demos/temp-email
cp .dev.vars.example .dev.vars   # dummy Turnstile + a local admin key
bun run dev                       # builds the client, applies migrations locally, starts wrangler dev
bun run smoke -- --smtp           # checks; --smtp posts to /cdn-cgi/handler/email
```

Wrangler dev can stop with `Network connection lost` when a file changes during a poll request. Start it again.

## Deploy (hosted)

```bash
cd demos/temp-email
bun run deploy                    # build, remote migrations, wrangler deploy
set -a && source ~/.theserverlessdev/temp-email.env && set +a
AGENT_API_KEY="$TEMP_EMAIL_API_KEY" bun run smoke -- https://email.lomvic.com
```
