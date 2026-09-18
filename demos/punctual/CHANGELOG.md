# Changelog — punctual vs Punctual

This demo is inspired by [CCCrafts/punctual](https://github.com/CCCrafts/punctual) (MIT, [punctual.sh](https://punctual.sh)). It is **original code**, not a drop-in fork. Upstream is a self-hostable single-team Calendly alternative. This repo is a **hosted demo** that shows the Cloudflare binding story on Workers Paid, without Workers for Platforms.

## Architecture

| | Punctual (upstream) | This demo |
| --- | --- | --- |
| Runtime | One Worker, full product (Hono-style app, ports/adapters) | One Worker, plain `fetch()` router, vanilla TS UI |
| Double-book | D1 `slot_locks` PK `(host_user_id, bucket_start)` at 5-minute buckets | D1 `slot_locks` PK `(host_id, slot_start)` for 30-minute slots |
| Coordination | Durable Object serialises, then re-checks Google/Microsoft | Durable Object `Calendar` serialises `book()`; no external calendar |
| Cache | KV availability | KV `CACHE`; delete on book |
| Reminders | Real email + `.ics`, 24 h / 1 h | Queue stub: consumer logs and writes `reminder_status=sent` |
| Files | R2 avatars / branding | None |
| Auth / OAuth | Google Calendar, Microsoft 365, signing keys | None (public demo host) |
| Extra products | Teams, event types, REST, MCP, webhooks, embed | Cut |
| UI | Upstream booking chrome | Graphite & Ember (`#c2410c` on `#0e0e11`), hub LogoMark |
| License | MIT | Original demo code; inspired-by MIT Punctual |

## What we cut

- Google Calendar and Microsoft 365 OAuth
- Teams, round-robin, collective scheduling
- Event types, buffers, notice windows, custom questions
- Real reminder email and `.ics` attachments
- R2 avatars and social cards
- REST API product, HMAC webhooks, embed widget
- Built-in MCP server
- 5-minute bucket engine and exhaustive timezone test matrix
- Ports/adapters so the same engine can go multi-tenant
- Workers for Platforms / dispatch namespaces

## What we kept (simplified)

- A public booking page: day → slot → name/email → confirm
- Storage-layer double-book prevention (`slot_locks`)
- Durable Object serialisation as the fast path
- KV cache of open slots
- Async reminder work on a Queue

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. Real LogoMark SVG. No purple-to-cyan logo.
