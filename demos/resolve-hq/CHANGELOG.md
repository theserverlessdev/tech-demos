# Changelog — resolve-hq vs ResolveHQ

This demo is a slice of [mirza-rizvi/ResolveHQ](https://github.com/mirza-rizvi/ResolveHQ) (`dev`), not a drop-in fork. Upstream is a self-hostable multi-tenant helpdesk. This repo is a **hosted demo** that shows the Cloudflare binding story on Workers Paid, without Workers for Platforms.

## Architecture

| | ResolveHQ (upstream) | This demo |
| --- | --- | --- |
| Runtime | One Worker, Hono, Vite + React | One Worker, plain `fetch()` router, vanilla TS UI |
| Store | D1 via Drizzle: orgs, users, tickets, customers, mail jobs, FTS… | D1: `tickets`, `messages`, `attachments`, `visitors`, `drafts` |
| Files | R2 through a `StorageProvider` | R2 put/get; allowlisted types; 24 h TTL; attachment + nosniff + CSP sandbox |
| Inbound mail | Email Routing `email()` → R2 staging → Queue; **`DEV_MAIL_MODE=capture`** for local/no MX | `DEV_MAIL_MODE=queue`: HTTP **Simulate inbound** → Queue body → consumer `INSERT OR IGNORE`s. No `email()`. |
| Outbound mail | Optional Resend (`RESEND_*`) + outbox + DLQ + cron `*/5` | Hourly sweep cron only (`23 * * * *`) |
| AI | Optional **OpenAI** (`OPENAI_*`, default `gpt-4o-mini`), workspace opt-in | **Workers AI** `@cf/zai-org/glm-5.3-flash` with `reasoning_effort: low` and 2,000 tokens. Labelled stub if unusable. |
| Auth | `SESSION_PEPPER`, CSRF, invitations, Owner/Admin/Agent | Turnstile + HMAC `rhq_session` cookie. Per-visitor sandbox for inbound tickets and uploads. |
| Rate limits | AUTH + WRITE bindings | `WRITE_LIMIT` 7331, `SESSION_LIMIT` 7530, `AI_LIMIT` 7531, `UPLOAD_LIMIT` 7532 + D1 daily budget |
| Queues | inbound, outbound, maintenance + DLQs | One inbound queue: `tech-demos-resolve-hq-inbound` |
| UI | Slack-inspired aubergine, Lato, Radix | Graphite & Ember (`#c2410c` on `#0e0e11`), hub LogoMark |
| Extra products | Help center, automations, reports, GDPR export/erasure | Cut |

## What we cut

- Multi-org tenancy and memberships
- Password auth, invitations, roles, workspace switcher
- Real Email Routing MX and Resend (`RESEND_*`)
- OpenAI secret (`OPENAI_*`) — drafts use the Workers AI binding
- RFC 5322 `In-Reply-To` / `References` threading (we match `ticketId` or a `[#1042]` subject token)
- Dead-letter queues, outbound outbox, five-minute recovery cron
- Saved replies, internal notes, FTS search, ticket `version` conflicts
- Knowledge base / public help center
- Automations, reports, CSV export
- GDPR JSON export and durable erasure workflows
- Workers for Platforms / dispatch namespaces

## What we kept (simplified)

- Shared seeded inbox with status, priority, assignee
- Three-pane list / thread / composer
- Attachments in R2
- Async inbound through a Queue
- Opt-in AI draft that does not block the reply path

## Audit remediations (this slice)

- Draft / inbound / upload: same-origin, Turnstile, session, dedicated rate limits, daily budget.
- Uploads: sniffed allowlist, attachment disposition, nosniff, CSP sandbox, CORP, size cap, 24 h sweep.
- Per-visitor sandbox so Simulate inbound cannot hijack another tab. Messages carry `visitor_id`; seed status/`updated_at` stay locked.
- Phone opens on the inbox; long subjects wrap; seed check is memoized; poll pauses when hidden.
- Turnstile widget lives under the status strip so phones can mint a session from the inbox.
- Hourly sweep deletes via subqueries (tickets last) and R2 batches of 1,000. Stale session cookies fall back to public seeds.

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. Real LogoMark SVG. No purple-to-cyan logo.
