# Plan — edgechat

## Goal

A visitor opens a named chat room on Workers and sees messages land live in a second tab, with history still there after refresh and a file that round-trips through object storage.

This is a **fresh small demo** inspired by the *idea* of [aozorae/Edgechat](https://github.com/aozorae/Edgechat) (~★693). Upstream is **GPL-3.0**. Do not copy, vendor, or reconstruct that source, assets, or substantial structure.

## Research (upstream, high level only)

Upstream is a self-hosted team chat on the Cloudflare stack: Workers (Hono) + Durable Objects with WebSocket hibernation (`ChannelRoom`, `UserInbox`) + D1 + KV sessions + R2 attachments, plus auth, E2EE-style encryption, Telegram/Discord bridges, and a Vue client.

| Upstream (idea only) | This slice |
| --- | --- |
| Durable Object rooms + hibernation | One `ChatRoom` DO per room name, Hibernation API (`acceptWebSocket`, `serializeAttachment`) |
| D1 message / channel tables | D1 `rooms` + `messages` + `attachments` |
| KV sessions | KV display-name session cookie (`publicId` is public; cookie value is not) |
| R2 encrypted attachments | R2 put/get under `uploads/`, no encryption keyring |
| Hono + Vue + GPL app | Plain `fetch()` router, vanilla TS UI |
| Auth, workspaces, bridges, E2EE | Cut |

**Cut (do not port):** Telegram / Discord bridges, full auth SaaS, E2EE / AES keyring, multi-workspace admin, UserInbox DO, Scheduler GC, Hono, Vue, any GPL source or assets.

**Resource names:** prefix `tech-demos-edgechat-*` (Worker, D1, KV, R2). Bindings stay short (`DB`, `SESSIONS`, `FILES`, `ROOM`).

## Single-user MVP

- In:
  - One Worker + static Graphite & Ember UI (LogoMark, Bricolage / Hanken, ember `#c2410c`, bg `#0e0e11`).
  - Join a room by name/id; DO broadcasts over hibernatable WebSockets; presence is a connection count + names stub that drops on leave.
  - D1 history: persist on send, load on join; survives refresh; hourly TTL prune.
  - KV session / display name. Cookie-only identity. Turnstile gates minting.
  - R2 upload in a room (`uploads/` prefix); PNG/JPEG/GIF/WebP preview.
  - Simple UI: room picker, scrolling message list, composer, upload. Mobile-fluid at 390px.
  - Hub registry + `/demos/edgechat`. `PLAN.md` / `README.md` / `CHANGELOG.md`.
- Out: everything in the research “Cut” row, plus Workers for Platforms / dispatch namespaces. No new Cloudflare resources in this pass (no deploy).

## Tasks

1. D1 schema + lobby seed; R2 seed object on first boot; `author_key` + denormalized room columns (migration `0002`). Migration `0003` redacts leftover `messages.session_id` cookie values.
2. KV session cookie (display name + `publicId`). Cookie-only `loadSession`. Records without `publicId` are rejected.
3. `ChatRoom` Durable Object: hibernation WebSocket, persist+broadcast, presence excluding the leaving socket, write rate limit, frame cap, auto ping/pong.
4. HTTP API: health, rooms (GET read-only), history, send, upload, file GET. Rooms created only on rate-limited writes.
5. Turnstile on `POST /api/session`. Persisted session required for upload, room create, WS upgrade.
6. Vanilla TS UI: reconnect, near-bottom autoscroll, 390px chips, Unicode room names.
7. Hourly `scheduled` prune + documented R2 lifecycle on `uploads/`.
8. Standalone Worker routes + hub fallback redirect.
9. Unit + smoke tests, 390px screenshot, video, PR. Owner applies secrets and the Turnstile widget.

## Stack

- **Workers + Static Assets**, `run_worker_first` for `/api` and `/ws`.
- **Durable Objects** — realtime fan-out with hibernation (Paid).
- **D1 / KV / R2 / RateLimit** — Paid-plan bindings already used in this repo.
- **Turnstile** — one solve mints a KV session.
- **No Hono, no Vue, no React, no GPL vendor.**

## Architecture

```
browser ──HTTPS──> Worker
                    ├─ GET  /api/session ─────────► cookie peek (no KV write)
                    ├─ POST /api/session ─────────► Turnstile + KV
                    ├─ GET  /api/rooms* ──────────► D1 read (404 if missing)
                    ├─ POST /api/rooms  / send / upload ──► rate limit + session + D1/R2
                    ├─ /api/files/:id ────────────► D1 meta + R2
                    └─ GET /ws/:room ─────────────► Origin + CONNECT_LIMIT + session
                                                      ChatRoom Durable Object
                                                      ├─ WRITE_LIMIT + socket bucket
                                                      ├─ persist on send ──► D1
                                                      └─ hibernatable WS fan-out
cron (hourly) ──► prune old D1 rows + R2 uploads
```

Worker `tech-demos-edgechat`:

- `tech-demos.theserverless.dev/demos/edgechat*`
- `edgechat.tech-demos.theserverless.dev/*`

## Cost

- One SQLite-backed DO class, one D1, one KV namespace, one R2 bucket.
- REST and WebSocket **writes share `WRITE_LIMIT` (40 / 60s per IP and per session)**. Upgrades use `CONNECT_LIMIT` (`7468`, 40 / 60s). Uploads capped at 1 MB and a global daily byte budget. `wrangler deploy` requires `TURNSTILE_SECRET`.
- Hourly prune: drop non-seed messages/attachments older than 7 days, keep the newest 500 per room, delete their R2 keys, drop empty non-lobby rooms. Owner should add an R2 lifecycle rule on `uploads/` (7 days).
- No Containers, Browser Rendering, Vectorize, WFP.

## Testing

- `bun test` (slug, origin, session cookie, files, token bucket, decode).
- `bun run typecheck`
- `scripts/smoke.ts`: health, Turnstile-gated session, lobby history, REST send, R2 upload, WebSocket echo, read-only GETs, header takeover rejected, Unicode room, bad percent-encoding.
- Two browser tabs in the same room see a live message. Message list scrolls at 390×844.
- Browser screenshot + short video on the PR.

## Deferred

- Real accounts, SSO, roles.
- E2EE, encrypted R2, disappearing messages.
- Bridges (Telegram, Discord, email).
- Per-user inbox Durable Object, unread badges, typing indicators.
- Multi-workspace admin.
- A production Turnstile widget (owner creates it; this pass only wires the gate).
