# Tanbase slice

An anonymous kanban on Cloudflare Workers. This is a **small demo** inspired by [tanfust/tanbase-core](https://github.com/tanfust/tanbase-core) (MIT, by tanfust), not a fork of that app. The shape of the idea is in [this post](https://x.com/wassimbenr/status/2104630626758652327).

- **Live:** <https://tech-demos.theserverless.dev/demos/tanbase/>
- **Subdomain:** <https://tanbase.tech-demos.theserverless.dev/>
- **Created with the Worker:** R2 bucket `tech-demos-tanbase`, Workflow `tech-demos-tanbase-split`
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)
- **Setup:** [SETUP.md](./SETUP.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What this demonstrates

**Pattern.** D1 is the board of record. One hibernating `BoardRoom` Durable Object per board fans creates, moves, edits, and deletes to every tab in the same browser. A Workflow splits a card and the drawer shows whether Workers AI or the fallback wrote the subtasks. There are no accounts and no share link. Boards expire after 7 days.

**What you can do**

- Create a board and add, edit, move, and delete cards.
- Open the same board in another tab of this browser and watch the Durable Object sync it.
- Attach a small file to a card (256 KB; PNG, JPEG, WEBP, GIF, PDF, or plain text).
- Split a card and see whether Workers AI or the fallback wrote the subtasks.

**What you could build**

- A private board per browser that stays in sync across its tabs.
- Live card updates across every open tab in that browser.
- A "split this task" action backed by a Workflow.

**Limits**

- A browser cookie scopes the boards: 3 boards, 40 cards, then a 7-day TTL.
- The hourly cron marks overdue cards in a log. It does not send email.
- Turnstile is required to create a board, upload, and split. A missing secret fails closed.

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **D1** | Visitors, boards, cards, attachment rows, reminder log, workflow step log. |
| **Durable Object** | One `BoardRoom` per board. `ctx.acceptWebSocket` fans create, move, edit, and delete out to every open tab. |
| **R2** | Card files, 256 KB cap, PNG / JPEG / WEBP / GIF / PDF / plain text. Deleted with the board. |
| **Workflows** | Split a card into about four subtasks (3–6 accepted). The UI shows load, Workers AI, and write. |
| **Workers AI** | The AI step asks `@cf/zai-org/glm-5.3-flash` with `reasoning_effort: low`, `max_tokens: 2000`, and a JSON schema. If the model is down or the JSON is unusable, that step picks four fallback subtasks and the write step stores them. A live paid call was not made in this repo, so production may still fall back until the owner confirms. |
| **Cron** | Hourly. Marks overdue cards and writes a reminder log. No email. Deletes boards older than 7 days, their R2 objects, unused visitors, and orphan rows (500 per table per run). |
| **Turnstile + rate limits** | Create board, upload, and split require a server-side Turnstile check. Every public write is rate-limited. Cookie-less reads do not write D1. Missing `TURNSTILE_SECRET` fails closed. |

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

- `tech-demos.theserverless.dev/demos/tanbase` and `…/demos/tanbase/*`
- `tanbase.tech-demos.theserverless.dev/*`

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.
