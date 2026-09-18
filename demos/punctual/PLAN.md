# Plan — punctual

## Goal

A solo operator can deploy this Worker, set a few vars/secrets, and run real office-hours booking: guests get ICS mail, can cancel, and the host can list upcoming bookings.

This is a **fresh small slice**, not a vendor of [CCCrafts/punctual](https://github.com/CCCrafts/punctual) (MIT, live at [punctual.sh](https://punctual.sh)).

## Research (upstream)

Upstream is a full single-team Calendly alternative on Workers: booking pages, Google/Microsoft calendar OAuth, event types, teams, REST + MCP, R2 avatars, HMAC webhooks, real reminder email with ICS.

| Upstream | This slice |
| --- | --- |
| D1 `slot_locks` PK `(host_user_id, bucket_start)` (5-minute buckets) | D1 `slot_locks` PK `(host_id, slot_start)` for configured slot length |
| Durable Object serialises attempts, then re-checks external calendars | Durable Object `Calendar` per host id serialises `book()` / `cancel()`; no Google/Microsoft |
| KV availability cache | KV `CACHE` of open slots; delete on book and cancel |
| Queues for real email (24 h / 1 h reminders, ICS) | One reminder Queue: delay up to 24 h before the slot; Resend BYOK or skip |
| R2 avatars / branding assets | Skip — ICS is calendar interop |
| OAuth calendars, teams, MCP, HMAC webhooks, event types | Cut |

**Cut (do not port):** Google/Microsoft OAuth, payments, multi-host SaaS, MCP product, R2 avatars, 5-minute bucket engine, timezone test matrix, ports/adapters architecture.

**Resource names:** prefix `tech-demos-punctual-*` (Worker, D1, KV, Queue). Bindings stay short (`DB`, `CACHE`, `REMINDERS`, `CALENDAR`, `BOOK_LIMIT`).

## Single-user MVP (grown)

- In:
  - One Worker + static Graphite & Ember UI (LogoMark, Bricolage / Hanken, ember `#c2410c` on `#0e0e11`).
  - Public booking: pick a weekday, pick a slot, name + email, confirm.
  - Host hours from wrangler vars (`HOST_*`, `SLOT_MINUTES`, `DAY_START`, `DAY_END`, `WEEKDAYS`, `PUBLIC_ORIGIN`).
  - D1 `slot_locks` + `bookings` + `reminders`. Unique live `(host_id, slot_start)` is the double-book guarantee.
  - Durable Object serialises book/cancel.
  - KV open-slot cache, invalidated on book and cancel.
  - Outbound email via Resend (`RESEND_API_KEY`, `MAIL_FROM`, `MAIL_FROM_NAME`). Missing key: fail-soft, booking still succeeds.
  - ICS attached to confirmation; `GET /api/bookings/:id/ics?t=` signed token.
  - Guest confirmation + optional `HOST_NOTIFY_EMAIL`. Reminder ~24 h before the slot (Queues delay, max 24 h per hop; if the slot is already inside 24 h, send immediately). Status is `sent` / `skipped` / `failed`.
  - Signed cancel link; frees `slot_locks`, invalidates KV, optional cancel email.
  - Light admin: `GET /api/admin/bookings` Bearer `ADMIN_API_KEY`.
  - Optional Turnstile on `POST /api/book` when `TURNSTILE_SECRET_KEY` is set (default off).
  - Rate limit `BOOK_LIMIT` on create.
  - Hub registry + `/demos/punctual`. `PLAN.md` / `README.md` / `SETUP.md` / `CHANGELOG.md`.
- Out: Google/Outlook OAuth free/busy, payments, teams, MCP, multi-host tenancy, full upstream port.

## Tasks

1. Host config from wrangler vars; slot engine parameterized.
2. D1: booking `status`, `mail_status`, `reminder_status` includes `skipped`; cancel frees locks.
3. Resend helper + ICS builder; HMAC tokens for ICS and cancel.
4. Queue reminder with `delaySeconds` (chain if lead time > 24 h).
5. Admin API + HTML; public cancel page.
6. Optional Turnstile; keep rate limit.
7. SETUP/README/CHANGELOG; smoke: book → ICS → cancel; email skipped without key.
8. Browser screenshot + video; deploy if wrangler auth exists.

## Stack

- **Workers + Static Assets**, `run_worker_first` for `/api`.
- **D1 / KV / Durable Objects / Queues / RateLimit** — Paid-plan bindings.
- **Resend** over `fetch` (no SDK). **No Hono, no React, no R2, no Workers AI, no WFP.**

## Architecture

```
browser ──HTTPS──> Worker
                    ├─ GET  /api/availability ──► KV (miss → D1 + slot engine)
                    ├─ POST /api/book ──────────► RateLimit → [Turnstile?] → Calendar DO
                    │                              ├─ D1 batch: slot_locks + bookings
                    │                              ├─ CACHE.delete
                    │                              ├─ Resend confirm + ICS (fail-soft)
                    │                              └─ REMINDERS.send({ sendAt }, delay)
                    ├─ GET  /api/bookings/:id/ics?t= ──► HMAC + text/calendar
                    ├─ POST /api/bookings/:id/cancel?t= ► Calendar.cancel
                    └─ GET  /api/admin/bookings ───────► Bearer ADMIN_API_KEY

Queue consumer ──► if still confirmed and sendAt due: reminder email
                    reminder_status = sent | skipped | failed
```

Worker `tech-demos-punctual`:

- `tech-demos.theserverless.dev/demos/punctual*`
- `punctual.tech-demos.theserverless.dev/*`

## Reminder timing

Queues may delay a message by **at most 24 hours**.

- Target send time = slot start − 24 h.
- If that is in the future by more than 24 h, the consumer re-enqueues the remainder.
- If the slot is already inside 24 h, the reminder is sent (or skipped if no Resend key) on the first consumer run.
- Cancelled bookings mark `reminder_status=skipped`.

## Cost

- D1/KV/Queue/DO demo traffic is far below Paid included amounts.
- Booking creates are rate-limited per IP (20 / 60s).
- Resend is BYOK; no send if the key is missing.
- No Containers, Browser Rendering, Vectorize, WFP, R2, Workers AI.

## Testing

- `bun run typecheck`
- `scripts/smoke.ts`: concurrent double-book, ICS download, cancel frees the slot, reminder status `sent` or `skipped` without a key, admin list when `ADMIN_API_KEY` is set.
- Browser screenshot + short video on the PR.

## Deferred

- Google Calendar free/busy.
- Multi-host round-robin.
- 1-hour reminder hop.
- Turnstile widget on the hosted demo (default off).
