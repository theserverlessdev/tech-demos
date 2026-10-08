# Company Brain slice

A sandbox org memory on Cloudflare Workers. This is a **small demo** inspired by [supermemoryai/company-brain](https://github.com/supermemoryai/company-brain) by supermemoryai, licensed Apache-2.0. It is not a fork of that app. The announcement post is [on X](https://x.com/DhravyaShah/status/2103668051468300701).

- **Live:** https://tech-demos.theserverless.dev/demos/company-brain/
- **Subdomain:** https://company-brain.tech-demos.theserverless.dev/
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

The hub URL is the deployed demo.

## What it proves

| Piece | What the demo does with it |
| --- | --- |
| **Agents SDK Durable Object** | One `Org` agent per sandbox. SQLite holds `facts` and `decisions` (`text`, `author`, `source`, `created_at`). |
| **Workers AI** | Answers using only retrieved rows from that org. The UI shows the fact or decision id and a snippet. If nothing relevant is stored, the reply is "I don't know." |
| **Turnstile** | Required on org creation and chat. |
| **Rate limits** | Create, chat, writes, and reads are capped per IP. |
| **DO alarm** | The agent schedules a wipe. When the alarm fires, facts, decisions, the transcript, and credential hashes are deleted. |

There is no Slack, Linear, or GitHub connector. A visitor can add rows in the memory pane, or `POST /api/orgs/:id/ingest` with the ingest token shown once at creation. The token is stored as a SHA-256 hash.

Orgs are not shared. Org A's session cannot read or write org B. The smoke test checks that.

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ Turnstile + rate limit
                      └─ Org Agent (DO SQLite)
                           ├─ facts / decisions
                           ├─ alarm → wipe
                           └─ Workers AI, only with retrieved rows
```

The hub path is `/demos/company-brain/`. Asset URLs are relative, and the client prefixes API calls when it is served under that path.

## Local

```bash
cd demos/company-brain
bun install
```

Put Cloudflare's published always-pass test secret in `.dev.vars` (gitignored):

```bash
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
```

`wrangler.jsonc` holds the live widget site key. Local `wrangler.offline.jsonc` keeps Cloudflare's always-pass test site key `1x00000000000000000000AA`. These test keys are [published by Cloudflare](https://developers.cloudflare.com/turnstile/troubleshooting/testing/), not a production credential. The Worker accepts the dummy token `XXXX.DUMMY.TOKEN.XXXX` only when the secret is that test secret **and** the host is localhost. A public hostname with the test secret fails closed. A missing `TURNSTILE_SECRET` also fails closed. Use `bun run dev:offline` for the dummy-token smoke path.

```bash
bun run dev
bun run scripts/smoke.ts http://127.0.0.1:8787
```

`bun run dev` uses the Workers AI binding. Current Wrangler has no local simulator for that binding, so it asks you to log in. Without a login, use `bun run dev:offline` (`wrangler.offline.jsonc` omits the binding). Memory, ingest, rate limits, and "I don't know" still run. A question that needs the model returns 503 instead of guessing.

## Deploy

From this folder, with the owner account (unset any other API token):

```bash
bunx wrangler whoami
# TURNSTILE_SITE_KEY in wrangler.jsonc is the live widget key.
# Widget hostnames: tech-demos.theserverless.dev, company-brain.tech-demos.theserverless.dev
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put TURNSTILE_SECRET
```

No D1 database or R2 bucket. The Durable Object class is created by the migration in `wrangler.jsonc`. Rate-limit namespace ids are `7361` (create), `7362` (chat), `7363` (write), and `7364` (read).

Routes:

- `tech-demos.theserverless.dev/demos/company-brain*`
- `company-brain.tech-demos.theserverless.dev/*`

The Worker is live at https://tech-demos.theserverless.dev/demos/company-brain/. Redeploy `apps/hub` when the gallery card should sit in front of the fallback redirect.

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.

## Ingest

```bash
curl -X POST "$ORIGIN/api/orgs/ORG_ID/ingest" \
  -H "content-type: application/json" \
  -H "x-ingest-token: YOUR_TOKEN" \
  -d '{"kind":"fact","text":"The warehouse is closed on Mondays.","author":"Ops","source":"webhook"}'
```

Text is capped at 800 characters. The body is capped at 8 KB.
