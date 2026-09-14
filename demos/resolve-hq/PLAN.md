# Plan — resolve-hq

## Goal

A visitor opens a shared support inbox on Workers and can list tickets, read a thread, attach a file, simulate inbound customer mail through a Queue, and draft a reply with Workers AI.

Upstream is [mirza-rizvi/ResolveHQ](https://github.com/mirza-rizvi/ResolveHQ) (`dev`). That app is a multi-tenant helpdesk with Hono, React, Drizzle, Email Routing, Resend, auth, automations, and a help center. This demo is a **fresh small slice** of the binding story — not a vendor of that codebase.

## Single-user MVP

- In:
  - One Worker with static assets (Graphite & Ember, LogoMark, Bricolage + Hanken).
  - D1 `tickets` + `messages` (status, priority, assignee stub, timestamps). Seed 4–5 tickets.
  - R2 attachment on at least one ticket: upload, list, download. Seed one file.
  - Queue producer + consumer: HTTP “simulate inbound email” enqueues; the consumer creates a ticket or appends to a thread. No live Email Routing MX.
  - Workers AI “Draft reply” that fills the composer. Opt-in per click; fail soft if AI is down.
  - Three-pane UI: ticket list | thread | reply composer. Mobile stacks with a back control.
  - Hub registry, `/demos/resolve-hq` zone route, docs, smoke script.
- Out:
  - Multi-org tenancy, sessions, invitations, Owner/Admin/Agent roles.
  - Resend outbound, real Email Routing MX, RFC 5322 threading, DLQs, outbox cron.
  - Help center, automations, reports, GDPR export/erasure workflows.
  - Workers for Platforms / dispatch namespaces.

## Tasks

1. D1 schema and seed tickets/messages; R2 seed object on first boot if missing.
2. HTTP API: list/get tickets, patch status/assignee, agent reply, attachment put/get, inbound enqueue, AI draft.
3. Queue consumer: new ticket from a simulated email, or append when `ticketId` / `[#number]` is present.
4. Workers AI draft from ticket subject + last messages; catch and return an unavailable payload.
5. Vanilla TypeScript UI, Bun-bundled, Graphite & Ember.
6. Standalone Worker routes (hub path + subdomain). Hub registry fallback redirects to the subdomain.
7. Smoke script, deploy, screenshot, short video, PR.

## Stack

- **Workers + Static Assets:** UI is static; the Worker runs first for `/api`. Same pattern as temp-email and apollo-desk.
- **D1:** two tables plus attachment metadata. Paid-plan, tiny row count.
- **R2:** attachment bytes. Object keys are opaque; download re-checks the D1 row.
- **Queues:** one inbound producer/consumer. The UI never writes tickets for “email”; the consumer does.
- **Workers AI** (`@cf/zai-org/glm-5.3-flash`): same model as apollo-desk. Drafts only; no OpenAI key.
- **No framework:** a handful of routes, so a plain `fetch()` router is enough.

## Architecture

```
browser ──HTTPS──> Worker
                    ├─ GET/PATCH /api/tickets* ──> D1
                    ├─ PUT/GET attachments ──────> D1 meta + R2 bytes
                    ├─ POST /api/inbound ────────> Queue.send
                    └─ POST /api/tickets/:id/draft ──> Workers AI (fail soft)

Queue consumer ──> create ticket or append message in D1
```

Standalone Worker `tech-demos-resolve-hq` (D1 + R2 + Queues + AI cannot run inside the hub Loader):

- `tech-demos.theserverless.dev/demos/resolve-hq*`
- `resolve-hq.tech-demos.theserverless.dev/*`

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.

## Cost

- D1/R2/Queue usage for a demo inbox is far below Paid included amounts.
- One draft is a short prompt. Cap `max_tokens` at 400. Rate-limit drafts and inbound simulates per IP.
- No Containers, Browser Rendering, Vectorize, or WFP.

## Testing

- `bun run typecheck`
- `scripts/smoke.ts` against local or live: seed list, attachment round-trip, queue-created ticket, draft text (or a soft-fail payload).
- Browser pass for screenshot and video.

## Deferred

- Cloudflare Email Routing `email()` handler on a throwaway zone (same caution as temp-email: never touch apex MX on `theserverless.dev`).
- Outbound mail / Resend.
- Saved replies, internal notes, FTS search, ticket version conflicts.
- Auth and multi-seat assignment beyond a stub name.
