# Punctual slice

A public booking page on Cloudflare Workers. This is a **small original demo** inspired by [CCCrafts/punctual](https://github.com/CCCrafts/punctual) (MIT, live at [punctual.sh](https://punctual.sh)), not a fork of that app.

- **Live:** <https://tech-demos.theserverless.dev/demos/punctual/>
- **Subdomain:** <https://punctual.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **D1** | `slot_locks` primary key `(host_id, slot_start)` plus `bookings`. Two guests cannot hold the same slot. |
| **Durable Object** | `Calendar` per host id serialises `book()`. Fast path; D1 unique is the guarantee. |
| **KV** | Open-slot cache. Deleted on every successful (or conflicting) book. |
| **Queues** | Enqueue a reminder stub on book. The consumer logs and stores `reminder_status=sent`. No email provider. |
| **RateLimit** | `BOOK_LIMIT` on `POST /api/book` (20 / 60s per IP). |

The UI is one public page: pick a weekday, pick a 30-minute slot, enter name + email, confirm. Graphite & Ember branding matches the hub (ember `#c2410c`, background `#0e0e11`, LogoMark SVG).

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ GET  /api/availability ──► KV (miss → D1 + slot engine)
                      └─ POST /api/book ──────────► RateLimit → Calendar DO
                                                      ├─ D1 batch: slot_locks + bookings
                                                      ├─ CACHE.delete
                                                      └─ REMINDERS.send

Queue consumer ──► reminders row + bookings.reminder_status = sent
```

One demo host: **Ankur Singh**, weekdays 09:00–17:00 America/Los_Angeles, 30-minute slots.

Cloudflare resources are prefixed `tech-demos-punctual-*` so they do not collide with other demos in this repo.

## Local

```bash
cd demos/punctual
bun install
bun run dev
```

Then `bun run scripts/smoke.ts http://127.0.0.1:8787`.

## Deploy

Needs D1, KV, a Queue, and a Durable Object (Paid). From this folder, with the owner account (unset any other `CF_API_TOKEN`):

```bash
export CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5
unset CF_API_TOKEN CLOUDFLARE_API_TOKEN
wrangler d1 create tech-demos-punctual
wrangler kv namespace create CACHE
wrangler queues create tech-demos-punctual-reminders
# put the D1 and KV ids into wrangler.jsonc, then:
bun run deploy
```

Routes:

- `tech-demos.theserverless.dev/demos/punctual*`
- `punctual.tech-demos.theserverless.dev/*`

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.
