# Plan — punctual

## Goal

A solo operator can deploy this Worker, set a few vars/secrets, and run real office-hours booking: guests get ICS mail, can cancel, the host can list upcoming bookings, and — when Google is connected — public slots respect real free/busy and a book writes a Calendar event.

This is a **fresh small slice**, not a vendor of [CCCrafts/punctual](https://github.com/CCCrafts/punctual) (MIT, live at [punctual.sh](https://punctual.sh)).

## Research (upstream)

Upstream is a full single-team Calendly alternative on Workers: booking pages, Google/Microsoft calendar OAuth, event types, teams, REST + MCP, R2 avatars, HMAC webhooks, real reminder email with ICS.

| Upstream | This slice |
| --- | --- |
| D1 `slot_locks` PK `(host_user_id, bucket_start)` (5-minute buckets) | D1 `slot_locks` PK `(host_id, slot_start)` for configured slot length |
| Durable Object serialises attempts, then re-checks external calendars | Durable Object `Calendar` per host id serialises `book()` / `cancel()`; Google free/busy is a second check |
| KV availability cache | KV `CACHE` of open slots; delete on book, cancel, and Google connect/disconnect |
| Queues for real email (24 h / 1 h reminders, ICS) | One reminder Queue: delay up to 24 h before the slot; Resend BYOK or skip |
| Google + Microsoft OAuth, multi-host | **One host** Google OAuth (freeBusy + events). No Microsoft |
| R2 avatars / branding assets | Skip — ICS remains calendar interop when Google is off |
| Teams, MCP, HMAC webhooks, event types | Cut |

**Cut (do not port):** Microsoft OAuth, payments, multi-host SaaS, MCP product, R2 avatars, 5-minute bucket engine, timezone test matrix, ports/adapters architecture, full upstream Punctual.

**Resource names:** prefix `tech-demos-punctual-*`. Bindings stay short (`DB`, `CACHE`, `REMINDERS`, `CALENDAR`, `BOOK_LIMIT`).

## Single-user MVP (Google connect)

- In:
  - Everything from the ICS/Resend/cancel/admin grow slice.
  - Host Google OAuth: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`. Redirect `${PUBLIC_ORIGIN}/api/google/callback`.
  - Scopes: `calendar.freebusy` + `calendar.events`.
  - Tokens encrypted-at-rest in D1 `host_google` for `HOST_ID`. Key: `TOKEN_ENCRYPTION_KEY` (falls back to `SIGNING_SECRET` if documented).
  - `/admin` Connect / Disconnect + connected account email (behind `ADMIN_API_KEY`).
  - Availability merges D1 locks with Google freeBusy; busy slots hidden. KV TTL 60s (platform minimum).
  - Book creates a Calendar event (fail-soft: D1 lock wins, `google=failed`). Cancel deletes the event.
  - No Google secrets → OAuth 503 `google_disabled`; availability stays D1-only.
  - Optional `GOOGLE_MOCK_BUSY` JSON for local screenshots/smoke without OAuth.
- Out: Microsoft Outlook, multi-host Google, team calendars product, full upstream port.

## Tasks

1. D1 `host_google` + `bookings.google_event_id` / `google_status`.
2. AES-GCM token box; OAuth start (admin) + callback + disconnect + status.
3. freeBusy merge in `Calendar.availability` / `book`; short KV TTL.
4. Event insert on book, delete on cancel; fail-soft.
5. Admin Connect UI; public strip when Google is merged.
6. SETUP/README/CHANGELOG; smoke skip/mock when unset.
7. Screenshot Connect + (if mock) a busy-hidden slot; Mac deploy notes.

## Stack

- **Workers + Static Assets**, `run_worker_first` for `/api`.
- **D1 / KV / Durable Objects / Queues / RateLimit** — Paid-plan bindings.
- **Google Calendar** over `fetch` (no SDK). **Resend** over `fetch`. **No Hono, no React, no R2, no Workers AI, no WFP.**

## Architecture

```
browser ──HTTPS──> Worker
                    ├─ GET  /api/availability ──► KV (miss → D1 locks ∪ Google freeBusy)
                    ├─ POST /api/book ──────────► RateLimit → [Turnstile?] → Calendar DO
                    │                              ├─ reject if Google-busy
                    │                              ├─ D1 batch: slot_locks + bookings
                    │                              ├─ Calendar.events insert (fail-soft)
                    │                              ├─ Resend confirm + ICS (fail-soft)
                    │                              └─ REMINDERS.send({ sendAt }, delay)
                    ├─ POST /api/google/start ──────► admin Bearer → Google authorize URL
                    ├─ GET  /api/google/callback ───► token exchange, encrypt into D1
                    ├─ POST /api/google/disconnect ─► delete tokens, invalidate KV
                    ├─ GET  /api/bookings/:id/ics?t=
                    ├─ POST /api/bookings/:id/cancel?t= ► D1 unlock + events.delete
                    └─ GET  /api/admin/bookings ───────► Bearer ADMIN_API_KEY

Queue consumer ──► reminder email; reminder_status = sent | skipped | failed
```

Worker `tech-demos-punctual`:

- `tech-demos.theserverless.dev/demos/punctual*`
- `punctual.tech-demos.theserverless.dev/*`

## Reminder timing

Unchanged: Queues delay at most 24 h per hop; target = slot − 24 h; cancelled bookings skip.

## Cost

- D1/KV/Queue/DO demo traffic is far below Paid included amounts.
- Booking creates are rate-limited per IP (20 / 60s).
- Resend and Google are BYOK; no call if the keys are missing.
- freeBusy is one POST per availability miss (60s KV cache).
- No Containers, Browser Rendering, Vectorize, WFP, R2, Workers AI.

## Testing

- `bun run typecheck`
- `scripts/smoke.ts`: previous book → ICS → cancel; Google routes 503/`configured:false` without secrets; optional mock busy hides a slot.
- Browser screenshot + short video on the PR.

## Deferred

- Microsoft 365 free/busy.
- Multi-host round-robin / team calendars.
- 1-hour reminder hop.
- Turnstile widget on the hosted demo (default off).
