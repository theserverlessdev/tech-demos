# Company Brain slice

A sandbox org memory on Cloudflare Workers. This is a **small demo** inspired by [supermemoryai/company-brain](https://github.com/supermemoryai/company-brain) by supermemoryai, licensed Apache-2.0. It is not a fork of that app. The announcement post is [on X](https://x.com/DhravyaShah/status/2103668051468300701).

- **Live:** https://tech-demos.theserverless.dev/demos/company-brain/
- **Subdomain:** https://company-brain.tech-demos.theserverless.dev/
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

The hub URL is the deployed demo.

## What this demonstrates

**Pattern.** One Agents SDK Durable Object per sandbox org stores facts and decisions in SQLite. Workers AI answers only from retrieved rows and cites the ids it used, or says it does not know. Orgs are not shared. An alarm calls `destroy()` so the object's storage is deleted.

**What you can do**

- Create a private org seeded with a few Northline facts and decisions.
- Ask a question and see cited fact or decision ids, or a refusal when nothing matches.
- Add a fact or decision in the memory pane.
- Ingest a row with the token shown once at creation. The token is stored as a SHA-256 hash.

**What you could build**

- An onboarding bot that only quotes the rows you loaded.
- A decision log whose answers cite the source row.
- A sandbox for the "I don't know" path before you add connectors.

**Limits**

- Org A's session cannot read or write org B.
- Turnstile is required on org creation and chat. Rate limits cap create, chat, writes, and reads.
- If Workers AI is unavailable, a question that needs the model returns 503 instead of guessing.

## What it proves

| Piece | What the demo does with it |
| --- | --- |
| **Agents SDK Durable Object** | One `Org` agent per sandbox. SQLite holds `facts` and `decisions` (`text`, `author`, `source`, `created_at`). |
| **Workers AI** | Answers using only retrieved rows from that org. The UI shows a citation only when the model included a matching `[kind:id]`. If nothing relevant is stored, or the model does not cite a retrieved row, the reply is "I don't know." |
| **Turnstile** | Required on org creation and chat. |
| **Rate limits** | Create, chat, writes, and reads are capped per IP. |
| **DO alarm** | The agent schedules a wipe. When the alarm fires, `this.destroy()` runs `deleteAll()` so the object is not left billed. |

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

Put Cloudflare's published always-pass test secret and a local HMAC key in `.dev.vars` (gitignored):

```bash
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
ORG_ID_KEY=local-dev-org-id-key-not-for-production
```

`wrangler.offline.jsonc` already sets that `ORG_ID_KEY` as a var for the dummy-token smoke path. Production must use `wrangler secret put ORG_ID_KEY` — do not commit a production key.

`wrangler.jsonc` holds the live widget site key. Local `wrangler.offline.jsonc` keeps Cloudflare's always-pass test site key `1x00000000000000000000AA`. These test keys are [published by Cloudflare](https://developers.cloudflare.com/turnstile/troubleshooting/testing/), not a production credential. The Worker accepts the dummy token `XXXX.DUMMY.TOKEN.XXXX` only when the secret is that test secret **and** the host is localhost. A public hostname with the test secret fails closed. A missing `TURNSTILE_SECRET` also fails closed. Use `bun run dev:offline` for the dummy-token smoke path.

```bash
bun run dev
bun run scripts/smoke.ts http://127.0.0.1:8787
```

`bun run dev` uses the Workers AI binding **remotely**, so local questions that reach the model are billed to the account. Current Wrangler has no local simulator for that binding, so it asks you to log in. Without a login, use `bun run dev:offline` (`wrangler.offline.jsonc` omits the binding). Memory, ingest, rate limits, the cited seed turn, and "I don't know" still run. A question that needs the model returns 503 instead of guessing. `bun run scripts/smoke.ts --require-ai` fails that 503.

Create a sandbox and the chat pane already shows a cited shipping answer from seed memory. Ask the wifi question to see the refusal. Ask the shipping question again only if you want a billed Workers AI call.

## Deploy

From this folder, with the owner account (unset any other API token):

```bash
bunx wrangler whoami
# TURNSTILE_SITE_KEY in wrangler.jsonc is the live widget key.
# Widget hostnames: tech-demos.theserverless.dev, company-brain.tech-demos.theserverless.dev
# workers_dev is false so the workers.dev hostname is not a third Turnstile host.
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put TURNSTILE_SECRET
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put ORG_ID_KEY
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
