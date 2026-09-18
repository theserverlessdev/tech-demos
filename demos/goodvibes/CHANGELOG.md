# Changelog — goodvibes vs GoodVibes

This demo is inspired by [benallfree/goodvibes](https://github.com/benallfree/goodvibes) (MIT), not a drop-in of that starter. Upstream is a vibecoding Three.js kit (Vite, Tailwind/DaisyUI, vanjs, `vibescale`). This repo is a **hosted slice** that shows Durable Object WebSocket hibernation on Workers Paid.

Original code in this folder. MIT, same as this monorepo. We did not copy the upstream `src/game`, `src/ui`, `src/controls`, or `vibescale` stack.

## Architecture

| | GoodVibes (upstream) | This demo |
| --- | --- | --- |
| Runtime | Vite app; Cloudflare assets from `./dist` | One Worker, `fetch()` router, Static Assets |
| 3D | Three.js + a full game/controls tree | bun-bundled Three.js: floor, capsule markers, WASD/click |
| Multiplayer | `vibescale` + DO stub in wrangler (commented) | `VibeRoom` DO, Hibernation API (`acceptWebSocket`) |
| UI | Tailwind, DaisyUI, vanjs | Graphite & Ember lobby + HUD |
| Rate limits | Not the demo's point | `CREATE_LIMIT` on room create |
| Extra | Image plugins, changesets, starter docs | Cut |

## What we cut

- Vite, `@cloudflare/vite-plugin`, Tailwind, DaisyUI, vanjs, `vibescale`
- Full game engine, physics, camera controllers, starter UI kit
- Auth SaaS, voice chat, persistent inventories
- Workers for Platforms / dispatch namespaces

## What we kept (simplified)

- Three.js in the browser
- Named rooms on Cloudflare
- Realtime positions over WebSockets backed by a Durable Object
- Bun as the install/build runtime

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. Real LogoMark SVG. No purple-to-cyan logo. The 3D scene stays dark so markers stay readable.
