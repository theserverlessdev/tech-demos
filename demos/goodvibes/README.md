# Ember Rush (goodvibes)

A **75-second multiplayer orb hunt** on Cloudflare Workers. Inspired by [benallfree/goodvibes](https://github.com/benallfree/goodvibes) (MIT), not a vendor of that starter kit.

- **Live:** <https://tech-demos.theserverless.dev/demos/goodvibes/>
- **Subdomain:** <https://goodvibes.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs the idea:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What this demonstrates

**Pattern.** One `VibeRoom` Durable Object per room is the coordinator. Hibernating WebSockets carry poses and scores. An alarm runs the countdown and the 75-second round. The room owns pickups, scores and the clock, and validates movement speed, so a second tab is another player.

**What you can do**

- Join a named room and open the link in a new tab or another browser.
- Start a round and move with the keyboard, a click, or the on-screen pad (on a phone, tap the floor or use the pad).
- Collect ember orbs (+1) and gold orbs (+3). Highest score wins. Play again without leaving.
- Play the same round on a 2D floor when WebGL cannot start.

**What you could build**

- A realtime game where the server owns pickups, scores and the round clock, and validates movement speed.
- A classroom activity with a shared timer and a scoreboard.
- A room that hibernates while players idle and wipes itself when the last one leaves.

**Limits**

- 2–8 players. Joining is capped at 8 players per room; new connections are rate-limited per IP.
- `POST /api/rooms` is Turnstile-gated and mints a short-lived HMAC join ticket. `/ws` will not wake a Durable Object without that ticket.
- This is an original game inspired by goodvibes, not a copy of that kit.
- There are no accounts. The Durable Object assigns a public player id per connection and is the only authority for scores.

## How to play

1. Finish the Turnstile check. Join a named room. Open the link in a new tab or another browser.
2. Hit **Start round**. 3–2–1, then 75 seconds.
3. WASD or click-to-move. On a phone, tap the floor or use the pad. Walk over glowing orbs.
4. Regular ember **+1**. Gold hot orb **+3**. Orbs respawn. There is always exactly one gold.
5. Highest score wins. **Play again** without leaving.

2–8 players. Graphite & Ember chrome (ember `#c2410c`, background `#0e0e11`, LogoMark).

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Static Assets** | Lobby + bun-bundled Three.js (2D floor if WebGL cannot start). |
| **Durable Objects** | One `VibeRoom` per room. Hibernatable WebSockets. Server-owned pickups, scores, round clock via `setAlarm`. Empty rooms `deleteAll`. |
| **Turnstile** | `POST /api/rooms` verifies the widget, then mints a two-minute HMAC join ticket. |
| **Rate Limiting** | `CONNECT_LIMIT` (30 / 60s / IP) on the WebSocket upgrade before the Durable Object wakes. |

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ POST /api/rooms ──────────► Turnstile + HMAC join ticket
                      ├─ GET  /api/health
                      ├─ GET  /api/config
                      └─ GET  /ws/:room ───────────► CONNECT_LIMIT ──► verify ticket ──► VibeRoom
                                                       ├─ serializeAttachment (pose, score, frame bucket)
                                                       ├─ storage (phase, orbs, scores) — wiped on last leave
                                                       └─ alarm (countdown + 75s round + idle kick)
```

Resources are prefixed `tech-demos-goodvibes-*`. Rate-limit namespace id is `7480` (`CONNECT_LIMIT`).

## Local

Copy `.dev.vars.example` to `.dev.vars` (test Turnstile pair + a local `JOIN_SECRET`).

```bash
cd demos/goodvibes
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

Then `bun run scripts/smoke.ts http://127.0.0.1:8787`.

Open two tabs on the same room (each tab finishes Turnstile), start a round, and race. If WebGL cannot start, the same game draws as a 2D map.

Standalone Worker (Durable Objects cannot run in the hub Loader). Use `bun run --filter @tech-demos/goodvibes dev` for the full bindings.

## Deploy

Needs Durable Objects + Rate Limiting + Turnstile (Workers Paid). On the owner account:

```bash
cd demos/goodvibes
wrangler secret put TURNSTILE_SECRET
wrangler secret put JOIN_SECRET
CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bun run deploy
```

`vars.TURNSTILE_SITE_KEY` is the production widget key already in `wrangler.jsonc`. `TURNSTILE_LOCAL` stays `"0"` in production so the always-pass test pair is rejected. Rate-limit namespace `7480` is created from this config on deploy — no extra Cloudflare API call.

Routes:

- `tech-demos.theserverless.dev/demos/goodvibes*`
- `goodvibes.tech-demos.theserverless.dev/*`
