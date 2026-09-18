# Plan — goodvibes

## Goal

A visitor opens a named 3D lobby on Workers, walks a marker around, and sees another browser tab in the same room move live — presence and positions over a hibernatable Durable Object WebSocket.

This is a **fresh small demo** inspired by [benallfree/goodvibes](https://github.com/benallfree/goodvibes) (MIT Bun/Three.js starter). Do not vendor the kit: no Vite, no vibescale, no DaisyUI/Tailwind, no wholesale `src/game` port.

## Research (upstream, high level only)

Upstream is a vibecoding starter: Vite + TypeScript + Three.js client, Bun tooling, and a Cloudflare deploy path. The committed `wrangler.toml` serves `./dist` assets; the Durable Object binding is commented as a template (`GoodVibes` / `GOODVIBES`). Networking is aimed at WebSockets + DOs for game state, plus a large UI/controls/game tree.

| Upstream (idea only) | This slice |
| --- | --- |
| Vite + Three.js + Tailwind/DaisyUI + vanjs | Static Assets + vanilla TS + bun-bundled Three.js |
| `vibescale` multiplayer helper | Plain JSON frames over a hibernatable DO WebSocket |
| DO class stub in wrangler | One `VibeRoom` DO per room name, Hibernation API |
| Full game / controls / UI kit | Floor, markers, click/WASD, presence list |
| Pages/assets `dist` pipeline | Workers + Static Assets, `run_worker_first` |

**Cut:** physics, auth SaaS, voice, full engine, Vite plugin stack, wholesale vendor of the starter.

**Resource names:** prefix `tech-demos-goodvibes-*`. Bindings stay short (`ROOM`, `CREATE_LIMIT`, `ASSETS`).

## Single-user MVP

- In:
  - One Worker + static Graphite & Ember chrome (LogoMark, Bricolage / Hanken, ember `#c2410c`, bg `#0e0e11`) around a readable dark 3D floor.
  - Join/create a room by name/id. Create is rate-limited.
  - `VibeRoom` Durable Object: hibernation WebSockets broadcast presence + `{x,z}` positions.
  - Minimal Three.js: avatars/markers; two tabs in the same room see each other move.
  - Hub registry + `/demos/goodvibes`. `PLAN.md` / `README.md` / `CHANGELOG.md`.
- Out: game engine, physics, accounts, voice, Workers for Platforms.

## Tasks

1. Worker router: assets, `POST /api/rooms` (rate limit), `GET /ws/:room` → DO.
2. `VibeRoom`: `acceptWebSocket`, `serializeAttachment`, presence + move fan-out.
3. Vanilla TS + Three.js lobby (bun bundle).
4. Hub fallback redirect + `tracking/seen.json`.
5. Smoke (HTTP + two WebSockets), local two-tab check, deploy if creds work, screenshot, video, PR.

## Stack

- **Workers + Static Assets**, `run_worker_first` for `/api` and `/ws`.
- **Durable Objects** (SQLite-backed class) — realtime fan-out with hibernation (Paid).
- **Rate Limiting** binding on room create.
- **Three.js** bundled for the browser. No React, no Vite, no Hono.

## Architecture

```
browser ──HTTPS──> Worker
                    ├─ POST /api/rooms ──────────► CREATE_LIMIT (per IP)
                    ├─ GET  /api/health
                    └─ GET  /ws/:room ───────────► VibeRoom Durable Object
                                                     ├─ hibernatable WS
                                                     ├─ presence (attachments)
                                                     └─ position fan-out
```

Worker `tech-demos-goodvibes`:

- `tech-demos.theserverless.dev/demos/goodvibes*`
- `goodvibes.tech-demos.theserverless.dev/*`

## Cost

- One SQLite-backed DO class. Hibernation so idle rooms do not pin duration.
- Room create limited per IP. Move frames ignored if they arrive too fast.
- No D1, KV, R2, Queues, Workers AI, Containers, Browser Rendering, WFP.

## Testing

- `bun run typecheck`
- `scripts/smoke.ts`: health, create, two WebSockets see join + move, create 429.
- Two browser tabs in the same room see live movement.
- Screenshot + short video on the PR.

## Deferred

- Physics, interpolation rewind, interest management.
- Accounts, persistent avatars, voice.
- Full goodvibes starter kit (Vite, vibescale, DaisyUI).
