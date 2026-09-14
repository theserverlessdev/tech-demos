# Plan — resolve-hq

## Goal

A visitor opens a shared support inbox on Workers and can list tickets, read a thread, attach a file, simulate inbound customer mail through a Queue, and draft a reply with Workers AI.

This is a **fresh small slice**, not a vendor of [mirza-rizvi/ResolveHQ](https://github.com/mirza-rizvi/ResolveHQ) (`dev`).

## Research (upstream `dev`)

Upstream is already **one Worker** (Hono + React SPA). It is not a multi-Worker or Workers-for-Platforms app.

| Upstream | This slice |
| --- | --- |
| D1 (Drizzle: orgs, users, tickets, customers, mail jobs, FTS…) | D1 `tickets` + `messages` + `attachments` |
| R2 `ATTACHMENTS` | Same binding name, one seeded file + upload |
| Queues: inbound, outbound, maintenance + DLQs | **One** inbound producer/consumer (`tech-demos-resolve-hq-inbound`) |
| Email Routing `email()` | Cut on day one |
| `DEV_MAIL_MODE=capture` (mail without live routing) | `DEV_MAIL_MODE=queue` — HTTP **Simulate inbound** → `Queue.send` → consumer writes D1 |
| Cron `*/5` (outbox, sessions, cleanup) | Cut |
| RateLimit (auth + writes) | `WRITE_LIMIT` on inbound, draft, upload, patch |
| `SESSION_PEPPER` secret | None — public demo inbox |
| Optional `RESEND_*` outbound | Cut |
| Optional `OPENAI_*` for drafts | **Workers AI** binding instead. No OpenAI secret for MVP. Fail soft if the model is down or the output is unusable. |

**Cut (do not port):** multi-org, invites, knowledge base, reports, automations, GDPR export/erasure, full Radix/Lato polish, WFP / dispatch namespaces.

**Resource names** (sticky-monorepo collision avoidance): prefix `tech-demos-resolve-hq-*` (Worker, D1, R2, Queue). Bindings stay short (`DB`, `ATTACHMENTS`, `INBOUND`, `AI`).

## Single-user MVP

- In:
  - One Worker + static Graphite & Ember UI (LogoMark, Bricolage / Hanken).
  - D1 tickets + messages (status, priority, assignee stub, timestamps). Seed 5 tickets.
  - R2 attachment round-trip; seed one file on `#1042`.
  - Queue inbound sim (`DEV_MAIL_MODE=queue`), not live Email Routing / Resend.
  - Workers AI **Draft reply**; no OpenAI key. Fail soft to a stub draft in the composer.
  - Three-pane UI: list | thread | composer. Mobile stacks.
  - Hub registry + `/demos/resolve-hq`. `PLAN.md` / `README.md` / `CHANGELOG.md`.
- Out: everything in the research “Cut” row, plus RFC 5322 threading, DLQs, outbound outbox.

## Tasks

1. D1 schema + seed; R2 seed object on first boot.
2. HTTP API: tickets, replies, attachments, inbound enqueue, AI draft.
3. Queue consumer creates or appends (`ticketId` / `[#number]`).
4. Workers AI draft; catch and fall back.
5. Vanilla TS UI, Bun bundle.
6. Standalone Worker routes + hub fallback redirect.
7. Smoke, deploy, screenshot, video, PR.

## Stack

- **Workers + Static Assets**, `run_worker_first` for `/api`.
- **D1 / R2 / Queues / Workers AI / RateLimit** — Paid-plan bindings already used in this repo.
- **No Hono, no React, no Drizzle, no OpenAI, no Resend.**

## Architecture

```
browser ──HTTPS──> Worker
                    ├─ /api/tickets* ──────────► D1
                    ├─ attachments ────────────► D1 meta + R2
                    ├─ POST /api/inbound ──────► Queue.send   (DEV_MAIL_MODE=queue)
                    └─ POST …/draft ───────────► Workers AI (fail soft → stub)

Queue consumer ──► create ticket or append message in D1
```

Worker `tech-demos-resolve-hq`:

- `tech-demos.theserverless.dev/demos/resolve-hq*`
- `resolve-hq.tech-demos.theserverless.dev/*`

## Cost

- D1/R2/Queue demo traffic is far below Paid included amounts.
- Drafts cap `max_tokens` at 400; writes are rate-limited per IP.
- No Containers, Browser Rendering, Vectorize, WFP.

## Testing

- `bun run typecheck`
- `scripts/smoke.ts`: seed list, R2 round-trip, queue-created ticket, draft text (`source` workers-ai or fallback).
- Browser screenshot + short video on the PR.

## Deferred

- `email()` on a throwaway zone (never touch apex MX on `theserverless.dev`).
- Resend outbound, DLQs, `*/5` recovery cron.
- Saved replies, FTS, ticket version conflicts, real auth.
