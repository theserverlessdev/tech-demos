# Plan — punctual

## Goal

A visitor books a 30-minute slot with one demo host on a public page; the edge refuses double-books of the same slot.

This is a **fresh small slice**, not a vendor of [CCCrafts/punctual](https://github.com/CCCrafts/punctual) (MIT, live at [punctual.sh](https://punctual.sh)).

## Research (upstream)

Upstream is a full single-team Calendly alternative on Workers: booking pages, Google/Microsoft calendar OAuth, event types, teams, REST + MCP, R2 avatars, HMAC webhooks, real reminder email with ICS.

| Upstream | This slice |
| --- | --- |
| D1 `slot_locks` PK `(host_user_id, bucket_start)` (5-minute buckets) | D1 `slot_locks` PK `(host_id, slot_start)` for 30-minute slots |
| Durable Object serialises attempts, then re-checks external calendars | Durable Object `Calendar` per host id serialises `book()`; no Google/Microsoft |
| KV availability cache | KV `CACHE` of open slots; delete on book |
| Queues for real email (24 h / 1 h reminders, ICS) | One reminder Queue: enqueue on book; consumer logs and stores `reminder_status=sent` |
| R2 avatars / branding assets | Skip — not needed for MVP |
| OAuth calendars, teams, MCP, HMAC webhooks, event types | Cut |

**Cut (do not port):** Google/Microsoft OAuth, payments, multi-host SaaS, MCP product, R2 avatars, real email provider, 5-minute bucket engine, timezone test matrix, ports/adapters architecture.

**Resource names:** prefix `tech-demos-punctual-*` (Worker, D1, KV, Queue). Bindings stay short (`DB`, `CACHE`, `REMINDERS`, `CALENDAR`, `BOOK_LIMIT`).

## Single-user MVP

- In:
  - One Worker + static Graphite & Ember UI (LogoMark, Bricolage / Hanken, ember `#c2410c` on `#0e0e11`).
  - Public booking: pick a weekday, pick a 30-minute slot, name + email, confirm.
  - D1 `slot_locks` + `bookings` + `reminders`. Unique `(host_id, slot_start)` is the double-book guarantee.
  - Durable Object serialises bookings for host `ankur`.
  - KV open-slot cache, invalidated on book.
  - Queue reminder stub (no Resend / SES).
  - Rate limit `BOOK_LIMIT` on create.
  - Hub registry + `/demos/punctual`. `PLAN.md` / `README.md` / `CHANGELOG.md`.
- Out: everything in the research “Cut” row, plus reschedule/cancel, ICS files, multi-host, auth.

## Tasks

1. D1 schema (`slot_locks`, `bookings`, `reminders`) + one seeded host.
2. Slot engine: weekdays 09:00–17:00 America/Los_Angeles, 30-minute slots, 10 upcoming days.
3. Durable Object `Calendar.book` + `Calendar.availability`; D1 unique as the lock; KV invalidate; Queue send.
4. Queue consumer writes a reminder row and marks the booking `sent`.
5. HTTP API + vanilla TS UI, Bun bundle.
6. Standalone Worker routes + hub fallback redirect.
7. Smoke (including concurrent double-book), deploy, screenshot, video, PR.

## Stack

- **Workers + Static Assets**, `run_worker_first` for `/api`.
- **D1 / KV / Durable Objects / Queues / RateLimit** — Paid-plan bindings.
- **No Hono, no React, no R2, no Workers AI, no WFP.**

## Architecture

```
browser ──HTTPS──> Worker
                    ├─ GET  /api/availability ──► KV (miss → D1 + slot engine)
                    └─ POST /api/book ──────────► RateLimit → Calendar DO
                                                    ├─ INSERT slot_locks + bookings (D1 batch)
                                                    ├─ CACHE.delete(date key)
                                                    └─ REMINDERS.send({ bookingId })

Queue consumer ──► reminders row + bookings.reminder_status = sent
```

Worker `tech-demos-punctual`:

- `tech-demos.theserverless.dev/demos/punctual*`
- `punctual.tech-demos.theserverless.dev/*`

## Cost

- D1/KV/Queue/DO demo traffic is far below Paid included amounts.
- Booking creates are rate-limited per IP (20 / 60s).
- No Containers, Browser Rendering, Vectorize, WFP, R2, Workers AI.

## Testing

- `bun run typecheck`
- `scripts/smoke.ts`: health, availability, concurrent double-book (one 201 + one 409), cache miss after book, reminder consumer.
- Browser screenshot + short video on the PR.

## Deferred

- Real email (Resend) and `.ics` in R2.
- Google Calendar free/busy.
- Reschedule / cancel links.
- Multi-host round-robin.
