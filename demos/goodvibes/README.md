# GoodVibes — Ember Rush

A **75-second multiplayer orb hunt** on Cloudflare Workers. Inspired by [benallfree/goodvibes](https://github.com/benallfree/goodvibes) (MIT), not a vendor of that starter kit.

- **Live (after deploy):** <https://tech-demos.theserverless.dev/demos/goodvibes/>
- **Subdomain (after deploy):** <https://goodvibes.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs the idea:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## How to play

1. Join (or create) a named room. Open a second tab.
2. Hit **Start round**. 3–2–1, then 75 seconds.
3. WASD or click-to-move. Walk over glowing orbs.
4. Regular ember **+1**. Gold hot orb **+3**. Orbs respawn.
5. Highest score wins. **Play again** without leaving.

2–8 players. Graphite & Ember chrome (ember `#c2410c`, background `#0e0e11`, LogoMark).

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Static Assets** | Lobby + bun-bundled Three.js (2D floor if WebGL cannot start). |
| **Durable Objects** | One `VibeRoom` per room. Hibernatable WebSockets. Server-authoritative orbs, scores, round clock via `setAlarm`. |
| **Rate Limiting** | `CREATE_LIMIT` on `POST /api/rooms` (8 creates / 60s / IP). |

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ POST /api/rooms ──────────► CREATE_LIMIT
                      ├─ GET  /api/health
                      └─ GET  /ws/:room ───────────► VibeRoom Durable Object
                                                       ├─ serializeAttachment (pose, score)
                                                       ├─ storage (phase, orbs, scores)
                                                       └─ alarm (countdown + 75s round)
```

Resources are prefixed `tech-demos-goodvibes-*`.

## Local

```bash
cd demos/goodvibes
bun install
bun run dev
```

Then `bun run scripts/smoke.ts http://127.0.0.1:8787`.

Open two tabs on the same room, start a round, and race. If WebGL cannot start, the same game draws as a 2D map.

Standalone Worker (Durable Objects cannot run in the hub Loader). Use `bun run --filter @tech-demos/goodvibes dev` for the full bindings.

## Deploy

Needs Durable Objects + Rate Limiting (Workers Paid). This cloud agent could not `wrangler deploy` (`wrangler whoami` unauthenticated). On the owner account:

```bash
cd demos/goodvibes
CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5
unset CF_API_TOKEN CLOUDFLARE_API_TOKEN
bun run deploy
```

Routes:

- `tech-demos.theserverless.dev/demos/goodvibes*`
- `goodvibes.tech-demos.theserverless.dev/*`
