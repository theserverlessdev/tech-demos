# Punctual slice

A public booking page on Cloudflare Workers. This is a **small original demo** inspired by [CCCrafts/punctual](https://github.com/CCCrafts/punctual) (MIT, live at [punctual.sh](https://punctual.sh)), not a fork of that app.

- **Live:** <https://tech-demos.theserverless.dev/demos/punctual/>
- **Subdomain:** <https://punctual.tech-demos.theserverless.dev/>
- **Self-host:** [SETUP.md](./SETUP.md)
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/theserverlessdev/tech-demos/tree/main/demos/punctual)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **D1** | `slot_locks` primary key `(host_id, slot_start)` plus `bookings`. Cancel deletes the lock. |
| **Durable Object** | `Calendar` per host id serialises `book()` and `cancel()`. D1 unique is the guarantee. |
| **KV** | Open-slot cache. Deleted on book and cancel. |
| **Queues** | Reminder ~24 h before the slot (max delay 24 h per hop). Status is `sent`, `skipped`, or `failed`. |
| **RateLimit** | `BOOK_LIMIT` on `POST /api/book` (20 / 60s per IP). |
| **Resend (BYOK)** | Confirmation + ICS to the guest, optional host notify, reminder, cancel. Missing key: booking still succeeds. |
| **Google Calendar (BYOK)** | Host OAuth on `/admin`. freeBusy hides busy slots; a book writes an event. Missing secrets: D1-only, OAuth `503`. |

The UI is a public page (day → slot → name/email → confirm) plus a light **Host list** behind `ADMIN_API_KEY`. Graphite & Ember branding matches the hub (ember `#c2410c`, background `#0e0e11`, LogoMark SVG).

Hours and timezone come from wrangler vars. When Google is connected, free/busy is merged in. ICS remains the guest calendar file.

## Reminder behavior

Queues can delay a message by at most **24 hours**.

- Target send time = slot start − 24 h.
- If that is further than 24 h away, the consumer re-enqueues the remainder.
- If the slot is already inside 24 h, the reminder runs on the first consumer pass.
- No `RESEND_API_KEY` / `MAIL_FROM`: `reminder_status=skipped`. Cancelled bookings also skip.

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ GET  /api/availability ──► KV 60s (miss → D1 ∪ Google freeBusy)
                      ├─ POST /api/book ──────────► RateLimit → Calendar DO
                      │                              Google event + Resend ICS (fail-soft)
                      │                              Queue reminder (delay)
                      ├─ POST /api/google/start ────── admin Bearer
                      ├─ GET  /api/google/callback
                      ├─ GET  /api/bookings/:id/ics?t=
                      ├─ POST /api/bookings/:id/cancel?t=
                      └─ GET  /api/admin/bookings     Bearer ADMIN_API_KEY
```

Default demo host: **Ankur Singh**, weekdays 09:00–17:00 America/Los_Angeles, 30-minute slots.

Cloudflare resources are prefixed `tech-demos-punctual-*`.

## Local

```bash
cd demos/punctual
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

Then `bun run scripts/smoke.ts http://127.0.0.1:8787`.

## Deploy

See [SETUP.md](./SETUP.md). From this folder, with the owner account:

```bash
export CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5
unset CF_API_TOKEN CLOUDFLARE_API_TOKEN
bun run deploy
```

Routes:

- `tech-demos.theserverless.dev/demos/punctual*`
- `punctual.tech-demos.theserverless.dev/*`
