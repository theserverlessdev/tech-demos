# Changelog — resolve-hq vs ResolveHQ

This demo is a slice of [mirza-rizvi/ResolveHQ](https://github.com/mirza-rizvi/ResolveHQ) (`dev`), not a drop-in fork. Upstream is a self-hostable multi-tenant helpdesk. This repo is a **hosted demo** that shows the Cloudflare binding story on Workers Paid, without Workers for Platforms.

## Architecture

| | ResolveHQ (upstream) | This demo |
| --- | --- | --- |
| Runtime | One Worker, Hono, Vite + React | One Worker, plain `fetch()` router, vanilla TS UI |
| Store | D1 via Drizzle: orgs, users, tickets, customers, mail jobs, FTS… | D1: `tickets`, `messages`, `attachments` |
| Files | R2 through a `StorageProvider` | R2 put/get on the Worker |
| Inbound mail | Email Routing `email()` → R2 staging → Queue pointer → RFC 5322 threading | HTTP **Simulate inbound** → Queue body → consumer writes D1 |
| Outbound mail | Resend + outbox + DLQ + cron | None |
| AI | Optional OpenAI (`gpt-4o-mini`), workspace opt-in | Workers AI `@cf/zai-org/glm-5.3-flash`, per-click, fail soft |
| Auth | Sessions, CSRF, invitations, Owner/Admin/Agent | None (public demo inbox) |
| UI | Slack-inspired aubergine, Lato, Radix | Graphite & Ember (`#c2410c` on `#0e0e11`), hub LogoMark |
| Extra products | Help center, automations, reports, GDPR export/erasure | Cut |

## What we cut

- Multi-org tenancy and memberships
- Password auth, invitations, roles, workspace switcher
- Real Email Routing MX and Resend
- RFC 5322 `In-Reply-To` / `References` threading (we match `ticketId` or a `[#1042]` subject token)
- Dead-letter queues, outbound outbox, five-minute recovery cron
- Saved replies, internal notes, FTS search, ticket `version` conflicts
- Knowledge base / public help center
- Automations, reports, CSV export
- GDPR JSON export and durable erasure workflows
- Workers for Platforms / dispatch namespaces

## What we kept (simplified)

- Shared inbox with status, priority, assignee
- Three-pane list / thread / composer
- Attachments in R2
- Async inbound through a Queue
- Opt-in AI draft that does not block the reply path

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. Real LogoMark SVG. No purple-to-cyan logo.
