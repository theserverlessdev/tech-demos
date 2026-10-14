# Changelog — goodvibes vs GoodVibes

This demo is inspired by [benallfree/goodvibes](https://github.com/benallfree/goodvibes) (MIT), not a drop-in of that starter. Upstream is a vibecoding Three.js kit. This folder is an **original Ember Rush game** on Workers Paid: Durable Object WebSocket hibernation plus a 75-second orb hunt.

We did not copy the upstream `src/game`, `src/ui`, `src/controls`, or `vibescale` stack.

## Architecture

| | GoodVibes (upstream) | This demo |
| --- | --- | --- |
| Runtime | Vite app; assets from `./dist` | One Worker, `fetch()` router, Static Assets |
| 3D | Three.js + a full game/controls tree | bun-bundled Three.js (2D fallback) |
| Multiplayer | `vibescale` + commented DO stub | `VibeRoom` hibernation WS, **server-authoritative round** |
| Loop | Starter sandbox | Ember Rush: countdown, 75s collect, scoreboard, rematch |
| UI | Tailwind, DaisyUI, vanjs | Graphite & Ember HUD |
| Rate limits | Not the point | Turnstile + HMAC join ticket; `CONNECT_LIMIT` on the WebSocket |

## What we cut

- Vite, Tailwind, DaisyUI, vanjs, `vibescale`
- Physics engine, RPG, voice, auth SaaS
- Workers for Platforms

## What we kept (and added)

- Three.js in the browser
- Named rooms on Cloudflare
- Realtime poses over a Durable Object
- **A complete short game:** orbs, scores, winner, Play again
- Round clock via Durable Object **alarms** (does not pin the isolate with `setInterval`)

## Branding

Hub Graphite & Ember. Ember `#c2410c`, background `#0e0e11`. LogoMark SVG. No purple-to-cyan logo.

## 2026-10-14

Opus audit of `279668d`. Disconnects no longer leave ghosts; an empty room `deleteAll`s. The no-op `CREATE_LIMIT` is gone. Joining is Turnstile-gated and mints an HMAC ticket; `/ws` checks the ticket, `CONNECT_LIMIT` (7480), a per-socket frame budget, and two sockets per IP. Player ids are server-assigned. Movement is speed-clamped. Exactly one gold orb. 390px camera, scoreboard dots, and 2D hint are readable. Copy matches what the demo does.

## 2026-10-09

Phone layout: 16px fields, 44px buttons, and safe-area padding. Ember Rush has an on-screen pad, and a tap on the floor still walks there. The 2D hint is drawn above that pad.
