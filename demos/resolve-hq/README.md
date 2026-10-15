# ResolveHQ slice

A support inbox on Cloudflare Workers. This is a **small demo** inspired by [mirza-rizvi/ResolveHQ](https://github.com/mirza-rizvi/ResolveHQ), not a fork of that app.

- **Live:** <https://tech-demos.theserverless.dev/demos/resolve-hq/>
- **Subdomain:** <https://resolve-hq.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

## What this demonstrates

**Pattern.** A Worker coordinates D1 tickets, R2 attachments, and a Queue consumer that turns a simulated inbound email into a ticket or a thread reply. **Draft reply** asks Workers AI after Turnstile, a signed session, a 5/min AI limit, and a shared daily budget; the composer shows whether the model or the stub path ran. There is no live mail exchanger.

**What you can do**

- Open a seeded ticket and read the thread (seeds are public).
- Attach a PNG, JPEG, PDF, or plain-text file (≤ 1 MB). It downloads as an attachment and is deleted after 24 hours.
- Simulate inbound mail and watch the consumer create a ticket **only this browser can see**.
- Ask for a draft reply. The page labels **Path: Workers AI · model** or **Path: stub fallback**.

**What you could build**

- A small inbox before you attach a live mail route.
- Queue-backed intake that becomes tickets.
- A reply desk that still fills a draft when the model is down, without leaving the AI path anonymous.

**Limits**

- Email Routing is not wired. Inbound is `DEV_MAIL_MODE=queue`.
- No OpenAI or Resend secret. Drafts use the Workers AI binding only.
- Five seeded conversations are **public**. Simulate inbound, replies, and uploads are a **per-visitor sandbox** and are swept hourly (24 h TTL).
- Draft, inbound, and upload are same-origin + Turnstile + session. The shared AI budget is 80 drafts/day (8/network).
- Files are not permanent hosting: allowlisted types, `Content-Disposition: attachment`, `nosniff`, sandboxed CSP, CORP.

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **D1** | Tickets and messages. Five public seeds. Visitor-sandbox rows + a daily draft counter. |
| **R2** | Attach a file to a ticket; list and download. Ticket `#1042` ships with a seeded invoice note. Uploads live under `tickets/<visitor>/…` and expire. |
| **Queues** | **Simulate inbound** enqueues a customer email with a pre-minted id. The consumer `INSERT OR IGNORE`s. No live Email Routing MX. |
| **Workers AI** | **Draft reply** fills the composer from a bounded ticket prompt (`reasoning_effort: low`, 2,000 tokens). If the model is down or the output is unusable, a labelled stub is returned. |
| **Turnstile + RateLimit** | Session mint (7530), AI drafts (7531, 5/min), uploads (7532), other writes (7331). |

The UI is three panes: ticket list, thread, reply composer. Graphite & Ember branding matches the hub (ember `#c2410c`, background `#0e0e11`, LogoMark SVG). Phones open on the inbox.

## How it works

```text
browser ── HTTPS ──► Worker (same-origin)
                      ├─ POST /api/session ──► Turnstile → signed cookie
                      ├─ /api/tickets* ──────► D1 (seeds + this visitor)
                      ├─ attachments ────────► D1 meta + R2 bytes (TTL)
                      ├─ POST /api/inbound ──► Queue.send (ids in the 202)
                      └─ POST …/draft ───────► Turnstile + AI_LIMIT + daily budget
                                               → Workers AI or labelled stub

Queue consumer ──► INSERT OR IGNORE ticket/message for that visitor
Cron 23 * * * * ──► restore seeds, delete stale visitor rows and R2 objects
```

Email Routing is **not** wired. Inbound uses `DEV_MAIL_MODE=queue`. A later slice can add `email()` on a throwaway zone; do not touch apex MX on `theserverless.dev` (Google Workspace).

Cloudflare resources are prefixed `tech-demos-resolve-hq-*` so they do not collide with other demos in this repo.

## Local

`bun run dev` uses [wrangler.local.jsonc](./wrangler.local.jsonc): no Workers AI binding, so it boots without `wrangler login`. Drafts return the labelled stub. Session mint uses the Turnstile test keys.

```bash
cd demos/resolve-hq
bun install
bun run dev
```

Then `bun run scripts/smoke.ts http://127.0.0.1:8787`. Smoke prints a **WARN** if the draft source is `fallback` (expected on this local config).

`bun run dev:ai` uses the production `wrangler.jsonc` (Workers AI is remote). That path needs `wrangler login` and **makes a paid model call** on the draft smoke step.

```bash
bun test
bun run typecheck
```

## Deploy

Needs the existing D1, R2, Queue, and Workers AI (Paid). This slice does not create new Cloudflare resources. From this folder, with the owner account (unset any other `CF_API_TOKEN`):

1. Create a Turnstile widget for `tech-demos.theserverless.dev` and `resolve-hq.tech-demos.theserverless.dev` (or reuse a widget that already allows those hosts). Put the site key in `wrangler.jsonc` `TURNSTILE_SITE_KEY`.
2. `printf '%s' "$TURNSTILE_SECRET" | wrangler secret put TURNSTILE_SECRET`
3. `openssl rand -hex 32 | wrangler secret put SESSION_SECRET`
4. `bun run deploy` (applies D1 migration `0003_sandbox.sql` and deploys).

Routes already exist:

- `tech-demos.theserverless.dev/demos/resolve-hq*`
- `resolve-hq.tech-demos.theserverless.dev/*`

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.
