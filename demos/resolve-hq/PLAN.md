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

- Keep `@cf/zai-org/glm-5.3-flash` with `reasoning_effort: "low"` and `max_tokens` / `max_completion_tokens` 2,000 (reasoning cannot be disabled on this model).
- UI shows **Path: Workers AI · &lt;model&gt;** or **Path: stub fallback**.
- Smoke prints a loud `WARN` when `source=fallback`. Local `wrangler.local.jsonc` has no AI binding so `bun run dev` does not need `wrangler login`.

## Should-fix

- **S1** Per-visitor sandbox: inbound ids are minted on enqueue; consumer `INSERT OR IGNORE`; client auto-selects only its own awaiting id; visitor tickets are invisible to other sessions.
- **S2** Phone opens on the inbox; `data-view="thread"` is set only by user handlers.
- **S3** Server caps + `overflow-wrap: anywhere` / `min-width: 0`.
- **S4** Hourly cron (`23 * * * *`): drop stale visitor rows/objects, restore seed tickets, sweep R2.
- **S5** Validate inbound before `Queue.send`; consumer `ack()`s permanent junk.
- **S6** Memoize `ensureSeed`; pause polling while the tab is hidden.
- **S7** Honest copy: public shared seeds, private visitor writes, Turnstile, daily budget, local-dev cost.

## Nits

Malformed ids → 404; deep-link assets remap + 302; atomic/idempotent consumer; `Content-Length` first; greeting-tolerant draft validator; 44 px tap targets; poll busy/error guard; 390 px stills.

## Stack

Workers + Static Assets, D1, R2, Queue, Workers AI, RateLimit (7331 + 7530–7533), Turnstile. Graphite & Ember. Bun.

## Owner steps (after merge)

Listed in the PR: set `TURNSTILE_SITE_KEY`, `wrangler secret put` for `TURNSTILE_SECRET` and `SESSION_SECRET`, apply D1 migration `0003`, deploy. No new Cloudflare resources are created here.
