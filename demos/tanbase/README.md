# Tanbase slice

An anonymous kanban on Cloudflare Workers. This is a **small demo** inspired by [tanfust/tanbase-core](https://github.com/tanfust/tanbase-core) (MIT, by tanfust), not a fork of that app. The shape of the idea is in [this post](https://x.com/wassimbenr/status/2104630626758652327).

- **Live:** <https://tech-demos.theserverless.dev/demos/tanbase/>
- **Subdomain:** <https://tanbase.tech-demos.theserverless.dev/>
- **Created with the Worker:** R2 bucket `tech-demos-tanbase`, Workflow `tech-demos-tanbase-split`
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)
- **Setup:** [SETUP.md](./SETUP.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **D1** | Visitors, boards, cards, attachment rows, reminder log, workflow step log. |
| **Durable Object** | One `BoardRoom` per board. `ctx.acceptWebSocket` fans create, move, edit, and delete out to every open tab. |
| **R2** | Card files, 256 KB cap, PNG / JPEG / WEBP / GIF / PDF / plain text. Deleted with the board. |
| **Workflows** | Split a card into 3–6 subtasks. The UI shows load, Workers AI, and write. |
| **Workers AI** | The split step. If the model is down or the JSON is unusable, the same step writes four fallback subtasks. |
| **Cron** | Hourly. Marks overdue cards and writes a reminder log. No email. Deletes boards older than 7 days and their R2 objects. |
| **Turnstile + rate limits** | Create board, upload, and split require a server-side Turnstile check. Every public write is rate-limited. Missing `TURNSTILE_SECRET` fails closed. |

There is no account. A `tb_vid` cookie scopes boards to the browser: 3 boards, 40 cards, then a 7-day TTL.

## How it works

```text
browser ── HTTPS + WebSocket ──► Worker
                                  ├─ BoardRoom DO ──► D1, then fan-out
                                  ├─ attachments ──► D1 meta + R2
                                  ├─ POST …/split ─► Workflow
                                  └─ cron ─────────► overdue log + TTL delete

Workflow ── load task ── Workers AI ── write subtasks ── notify the DO
```

## Local

```bash
cd demos/tanbase
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

`.dev.vars` holds Cloudflare's published always-pass Turnstile **test** secret so smoke can send the dummy token, and it overrides `TURNSTILE_SITE_KEY` with the matching test key `1x00000000000000000000AA`. `wrangler.jsonc` keeps the live site key. Production leaves `ALLOW_LOCAL_HOOKS` empty and stores `TURNSTILE_SECRET` with `wrangler secret put`, not as a var. Then:

```bash
bun run scripts/smoke.ts http://127.0.0.1:8787
```

`POST /api/sweep` runs the same cleanup as the hourly cron. `ttlSeconds` on create lets smoke expire a board without waiting 7 days. Both stay off unless `ALLOW_LOCAL_HOOKS=1`, which `.dev.vars` sets for local dev and production must leave empty. Wrangler rewrites the local Host header to the zone route, so the gate is that var and not the hostname.

## Deploy

See [SETUP.md](./SETUP.md). Routes:

- `tech-demos.theserverless.dev/demos/tanbase*`
- `tanbase.tech-demos.theserverless.dev/*`

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.
