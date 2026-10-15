# Plan — resolve-hq (audit remediations)

## Goal

Close every finding in the resolve-hq audit: the Workers AI draft is same-origin, Turnstile-gated, session-bound, rate-limited, and budgeted; uploads are not anonymous permanent hosting on the hub origin; the draft path is a real model call with an honest label; and each visitor’s inbox writes stay in their own sandbox.

This is still a **small hosted slice**, not a vendor of [mirza-rizvi/ResolveHQ](https://github.com/mirza-rizvi/ResolveHQ).

## Out of scope

- New GitHub repo, deploy, or Cloudflare API changes (no new D1 / R2 / Queue / Turnstile widget from this agent).
- Workers for Platforms, live Email Routing, Resend, OpenAI.
- Rate-limit namespace ids outside **7530–7539** (existing `WRITE_LIMIT` 7331 stays).

## Blockers

### B1 — Draft cost sink

- `POST /api/session` (Turnstile `session`) mints an HMAC-signed `rhq_session` cookie.
- `POST …/draft` requires same-origin (`Sec-Fetch-Site` or matching `Origin`), the session, a fresh Turnstile token (`draft`), `AI_LIMIT` (7531, 5/min), and a D1 daily budget (global + per-network).
- Prompt bounds: subject ≤ 200 chars, last 4 messages × 1,500 chars.
- `cf-connecting-ip` only (no `x-forwarded-for`).
- Inbound and uploads also require same-origin + session + Turnstile (`write`).

### B2 — File hosting

- Allowlist `text/plain`, `image/png`, `image/jpeg`, `application/pdf` (sniffed).
- Serve as `application/octet-stream` unless allowlisted; always `attachment`, `nosniff`, `CSP default-src 'none'; sandbox`, `CORP: same-origin`.
- 1 MB cap, early `Content-Length` reject.
- Visitor-scoped keys; hourly cron deletes non-seed objects and rows older than 24 h.

### B3 — Real draft, labelled path

- Keep `@cf/zai-org/glm-5.3-flash` with `reasoning_effort: "low"` and `max_completion_tokens` 2,000 (no deprecated `max_tokens`; `finish_reason=length` is unusable).
- UI shows **Path: Workers AI · &lt;model&gt;** or **Path: stub fallback**.
- Smoke prints a loud `WARN` when `source=fallback`. Local `wrangler.local.jsonc` has no AI binding so `bun run dev` does not need `wrangler login`. Live Workers AI screenshot is an owner step.

## Should-fix

- **S1** Per-visitor sandbox: inbound ids are minted on enqueue; consumer `INSERT OR IGNORE`; client waits on its own `messageId`; visitor tickets and visitor messages are invisible to other sessions.
- **S2** Phone opens on the inbox; `data-view="thread"` is set only by user handlers.
- **S3** Server caps + `overflow-wrap: anywhere` / `min-width: 0`.
- **S4** Hourly cron (`23 * * * *`): drop stale visitor rows/objects, delete leftover `visitor_id IS NULL` non-seeds, prune `visitors`, restore seed fields including `updated_at`, sweep R2.
- **S5** Validate inbound before `Queue.send`; consumer `ack()`s permanent junk.
- **S6** Memoize `ensureSeed`; pause polling while the tab is hidden.
- **S7** Honest copy: public original seed threads, private visitor writes (including on seeds), locked seed status/order, Turnstile, daily budget, local-dev stub.
- **R1** `messages.visitor_id` (migration 0004); seed status/priority/assignee/`updated_at` locked.
- **R2** `TURNSTILE_SITE_KEY` stays `REPLACE_ME` until the owner sets a widget. Seeds load without a session (read-only).
- **R3** `#turnstile` and `#hint` sit under the status strip; errors and Turnstile scroll that bar into view, and the composer mirrors the hint.
- **R4** A `session*` 401 remints once and retries.
- **N1** Sweep deletes via subqueries (tickets last) and R2 batches of 1,000.
- **N3** Queue wait timeout clears the waiting state so polling resumes.
- **N4/N5** Seeds load before session mint; stale cookies fall back to public seeds.

## Nits

Malformed ids → 404; deep-link assets remap + 302; atomic/idempotent consumer; `Content-Length` first; greeting-tolerant draft validator; 44 px tap targets; poll busy/error guard; 390 px stills.

## Stack

Workers + Static Assets, D1, R2, Queue, Workers AI, RateLimit (7331 + 7530–7533), Turnstile. Graphite & Ember. Bun.

## Owner steps (after merge)

Listed in the PR: replace `REPLACE_ME` in `TURNSTILE_SITE_KEY`, `wrangler secret put` for `TURNSTILE_SECRET` and `SESSION_SECRET`, apply D1 migrations through `0004`, deploy. No new Cloudflare resources are created here.
