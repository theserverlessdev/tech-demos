# Plan — goodvibes (Ember Rush)

## Goal

Two visitors join a named arena on Workers, start a 75-second round, and race to collect ember orbs. Highest score wins. Rematch without leaving the room. The Cloudflare story is a hibernatable Durable Object WebSocket that owns pickups, scores and the clock, and validates movement speed.

This is a **fresh small game** inspired by [benallfree/goodvibes](https://github.com/benallfree/goodvibes) (MIT). Do not vendor the kit.

## Single-user MVP

- In:
  - Graphite & Ember chrome (LogoMark, ember `#c2410c`, bg `#0e0e11`).
  - Join by room name. `POST /api/rooms` is Turnstile-gated and mints a short-lived HMAC join ticket. `/ws` checks the ticket and `CONNECT_LIMIT`.
  - `VibeRoom` DO: hibernation WebSockets, presence, **orb collect, score, round clock via `setAlarm`**. Last leave `deleteAll`s storage.
  - Server-assigned public player ids. Movement speed clamped. Exactly one gold orb (+3).
  - 2–8 players. WASD / click-to-move / pad. Named colored avatars.
  - Round: waiting → 3s countdown → 75s play → scoreboard / winner → Play again.
  - Three.js when WebGL works; 2D floor otherwise. 390px camera shows the arena.
- Out: physics engine, RPG, voice, accounts, wholesale goodvibes vendor, WFP, deploy from this agent.

## Tasks (audit 279668d)

1. B1: `drop()` excludes the closing socket; empty rooms `deleteAll`.
2. B2: `CONNECT_LIMIT` (7480) + frame budget + Turnstile join ticket on WS. Remove `CREATE_LIMIT` on the no-op.
3. S1–S8: server ids, speed clamp, gold stays +3, 390px camera, scoreboard dots, 2D hint, honest copy, room-full close 4001.
4. Nits: clock, `serverNow`, URI/404/origin, Unicode names, Three.js dispose, smoke coverage.

## Stack

Workers + Static Assets + Durable Objects (SQLite, Hibernation) + Rate Limiting + Turnstile. Bun-bundled Three.js. No Vite/Hono/React.

## Architecture

```
browser ──HTTPS──> Worker
                    ├─ POST /api/rooms ──► Turnstile ──► HMAC join ticket
                    └─ GET  /ws/:room  ──► CONNECT_LIMIT ──► verify ticket ──► VibeRoom
                                           ├─ attachments: pose + score + frame bucket
                                           ├─ storage: round / orbs (wiped on last leave)
                                           └─ alarm: countdown + 75s clock + idle kick
```

## Testing

- `bun run typecheck` + `scripts/smoke.ts` (presence after leave, empty-room reset, no id takeover, speed clamp, one gold orb, 1008 ghost gone while TCP stays open, deep-link backoff bounds)
- 390×844 screenshot + video on the PR
