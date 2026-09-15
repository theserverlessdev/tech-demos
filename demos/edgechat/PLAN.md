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
| KV sessions | KV display-name session cookie |
| R2 encrypted attachments | R2 put/get, no encryption keyring |
| Hono + Vue + GPL app | Plain `fetch()` router, vanilla TS UI |
| Auth, workspaces, bridges, E2EE | Cut |

**Cut (do not port):** Telegram / Discord bridges, full auth SaaS, E2EE / AES keyring, multi-workspace admin, UserInbox DO, Scheduler GC, Hono, Vue, any GPL source or assets.

**Resource names:** prefix `tech-demos-edgechat-*` (Worker, D1, KV, R2). Bindings stay short (`DB`, `SESSIONS`, `FILES`, `ROOM`).

## Single-user MVP

- In:
  - One Worker + static Graphite & Ember UI (LogoMark, Bricolage / Hanken, ember `#c2410c`, bg `#0e0e11`).
  - Join a room by name/id; DO broadcasts over hibernatable WebSockets; presence is a connection count + names stub.
  - D1 history: persist on send, load on join; survives refresh.
  - KV session / display name.
  - R2 upload in a room; the message shows a link (and an image preview when the type is an image).
  - Simple UI: room picker, message list, composer, upload. Mobile stacks.
  - Hub registry + `/demos/edgechat`. `PLAN.md` / `README.md` / `CHANGELOG.md`.
- Out: everything in the research “Cut” row, plus Workers for Platforms / dispatch namespaces.

## Tasks

1. D1 schema + lobby seed; R2 seed object on first boot.
2. KV session cookie (display name).
3. `ChatRoom` Durable Object: hibernation WebSocket, persist+broadcast, presence stub.
4. HTTP API: health, rooms, history, send, upload, file GET.
5. Vanilla TS UI, Bun bundle.
6. Standalone Worker routes + hub fallback redirect.
7. Smoke, local two-tab check, deploy if credentials work, screenshot, video, PR.

## Stack

- **Workers + Static Assets**, `run_worker_first` for `/api` and `/ws`.
- **Durable Objects** — realtime fan-out with hibernation (Paid).
- **D1 / KV / R2 / RateLimit** — Paid-plan bindings already used in this repo.
- **No Hono, no Vue, no React, no GPL vendor.**

## Architecture

```
browser ──HTTPS──> Worker
                    ├─ /api/session ──────────────► KV
                    ├─ /api/rooms* ───────────────► D1
                    ├─ /api/files/:id ────────────► D1 meta + R2
                    ├─ POST upload / REST send ───► D1 + R2, then DO broadcast
                    └─ GET /ws/:room ─────────────► ChatRoom Durable Object
                                                      ├─ persist on send ──► D1
                                                      └─ hibernatable WS fan-out
```

Worker `tech-demos-edgechat`:

- `tech-demos.theserverless.dev/demos/edgechat*`
- `edgechat.tech-demos.theserverless.dev/*`

## Cost

- One SQLite-backed DO class, one D1, one KV namespace, one R2 bucket.
- Writes rate-limited per IP. Uploads capped at 1 MB.
- No Containers, Browser Rendering, Vectorize, WFP.

## Testing

- `bun run typecheck`
- `scripts/smoke.ts`: health, session, lobby history, REST send, R2 upload round-trip, WebSocket echo.
- Two browser tabs in the same room see a live message.
- Browser screenshot + short video on the PR.

## Deferred

- Real accounts, SSO, roles.
- E2EE, encrypted R2, disappearing messages.
- Bridges (Telegram, Discord, email).
- Per-user inbox Durable Object, unread badges, typing indicators.
- Multi-workspace admin.
