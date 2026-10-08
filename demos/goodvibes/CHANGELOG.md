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
| Rate limits | Not the point | `CREATE_LIMIT` on room create |

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
