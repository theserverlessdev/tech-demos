# Changelog — punctual vs Punctual

This demo is inspired by [CCCrafts/punctual](https://github.com/CCCrafts/punctual) (MIT, [punctual.sh](https://punctual.sh)). It is **original code**, not a drop-in fork. Upstream is a self-hostable single-team Calendly alternative. This repo is a **hosted demo plus a self-hostable slice** of the Cloudflare binding story on Workers Paid, without Workers for Platforms.

## Architecture

| | Punctual (upstream) | This demo |
| --- | --- | --- |
| Runtime | One Worker, full product (Hono-style app, ports/adapters) | One Worker, plain `fetch()` router, vanilla TS UI |
| Double-book | D1 `slot_locks` PK `(host_user_id, bucket_start)` at 5-minute buckets | D1 `slot_locks` PK `(host_id, slot_start)` for configured slot length |
| Coordination | Durable Object serialises, then re-checks Google/Microsoft | Durable Object `Calendar` serialises `book()` / `cancel()`; optional Google free/busy |
| Cache | KV availability | KV `CACHE`; delete on book, cancel, and Google connect/disconnect |
| Reminders | Real email + `.ics`, 24 h / 1 h | Queue reminder ~24 h before the slot; Resend + ICS or `skipped` |
| Files | R2 avatars / branding | None |
| Auth / OAuth | Google Calendar, Microsoft 365, signing keys | HMAC ICS/cancel; Bearer admin; **one-host Google** (freeBusy + events). No Microsoft |
| Extra products | Teams, event types, REST, MCP, webhooks, embed | Cut |
| Host config | Dashboard + OAuth calendars | Wrangler vars + `/admin` Google connect |
| UI | Upstream booking chrome | Graphite & Ember (`#c2410c` on `#0e0e11`), hub LogoMark |
| License | MIT | Original demo code; inspired-by MIT Punctual |

## What we cut

- Microsoft 365 OAuth / free-busy
- Teams, round-robin, collective scheduling
- Event types, buffers, notice windows, custom questions
- R2 avatars and social cards
- REST API product, HMAC webhooks, embed widget
- Built-in MCP server
- 5-minute bucket engine and exhaustive timezone test matrix
- Ports/adapters so the same engine can go multi-tenant
- Workers for Platforms / dispatch namespaces
- Payments

## What we kept (simplified)

- A public booking page: day → slot → name/email → confirm
- Storage-layer double-book prevention (`slot_locks`)
- Durable Object serialisation as the fast path
- KV cache of open slots, invalidated on book and cancel
- **Resend BYOK** confirmation + optional host notify; missing key is fail-soft
- **ICS** attached to mail and `GET /api/bookings/:id/ics` (signed)
- **Signed cancel** that frees the lock
- **Queue reminder** with honest `sent` / `skipped` / `failed`
- **Light admin list** (`ADMIN_API_KEY`)
- **Google Calendar connect** (this slice): encrypted tokens in D1, freeBusy merge, event write/delete, fail-soft when unset
- Optional Turnstile (default off); rate limit always on

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. Real LogoMark SVG. No purple-to-cyan logo.
