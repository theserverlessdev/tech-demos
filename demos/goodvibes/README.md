# GoodVibes slice

A 3D multiplayer lobby on Cloudflare Workers. This is a **small original demo** inspired by [benallfree/goodvibes](https://github.com/benallfree/goodvibes) (MIT), not a vendor of that starter kit.

- **Live (after deploy):** <https://tech-demos.theserverless.dev/demos/goodvibes/>
- **Subdomain (after deploy):** <https://goodvibes.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs the idea:** [CHANGELOG.md](./CHANGELOG.md)

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Static Assets** | Lobby UI (join/create by room name) plus the bundled Three.js client. |
| **Durable Objects** | One `VibeRoom` per room name. Hibernatable WebSockets broadcast presence and `{x,z}` positions. |
| **Rate Limiting** | `CREATE_LIMIT` on `POST /api/rooms` (8 creates / 60s / IP). |

Open two tabs on the same room. Click the floor or use WASD — the other tab should see the marker move without a refresh. Graphite & Ember chrome matches the hub (ember `#c2410c`, background `#0e0e11`, LogoMark SVG). The 3D floor stays dark and readable; we do not force a purple→cyan look.

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ POST /api/rooms ──────────► CREATE_LIMIT
                      ├─ GET  /api/health
                      └─ GET  /ws/:room ───────────► VibeRoom Durable Object
                                                       ├─ serializeAttachment (id, name, pose)
                                                       └─ hibernatable WS fan-out
```

Cloudflare resources are prefixed `tech-demos-goodvibes-*` so they do not collide with other demos in this repo.

## Local

```bash
cd demos/goodvibes
bun install
bun run dev
```

Then `bun run scripts/smoke.ts http://127.0.0.1:8787`.

Open two browser tabs on the same room. Move in one; the other should follow live.

This demo is a standalone Worker (Durable Objects cannot run inside the hub's Dynamic Worker Loader). From the repo root the gallery still lists it; for the full bindings use `bun run --filter @tech-demos/goodvibes dev`.

## Deploy

Needs Durable Objects and the Rate Limiting binding (Workers Paid). From this folder, with the owner account (`CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5`; unset any other `CF_API_TOKEN` / `CLOUDFLARE_API_TOKEN` if they point at the wrong account):

```bash
bun run deploy
```

Routes:

- `tech-demos.theserverless.dev/demos/goodvibes*`
- `goodvibes.tech-demos.theserverless.dev/*`

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.
