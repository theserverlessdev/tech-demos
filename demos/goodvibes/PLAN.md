# Plan — goodvibes (Ember Rush)

## Goal

Two visitors join a named arena on Workers, start a 75-second round, and race to collect ember orbs. Highest score wins. Rematch without leaving the room. The Cloudflare story is a hibernatable Durable Object WebSocket that is **server-authoritative** for the game.

This is a **fresh small game** inspired by [benallfree/goodvibes](https://github.com/benallfree/goodvibes) (MIT). Do not vendor the kit.

## Single-user MVP

- In:
  - Graphite & Ember chrome (LogoMark, ember `#c2410c`, bg `#0e0e11`).
  - Join/create by room name. Create is rate-limited.
  - `VibeRoom` DO: hibernation WebSockets, presence, positions, **orb collect, score, round clock via `setAlarm`**.
  - 2–8 players. WASD / click-to-move. Named colored avatars.
  - Round: waiting → 3s countdown → 75s play → scoreboard / winner → Play again.
  - Gold “hot” orb is +3; regular ember is +1; orbs respawn.
  - Three.js when WebGL works; 2D floor otherwise. Snappy motion + collect beep/burst.
- Out: physics engine, RPG, voice, auth, wholesale goodvibes vendor, WFP.

## Tasks

1. Protocol: `start` / `round` / `collect` plus existing hello/move.
2. DO game snap in `storage` + alarm for countdown/round end (hibernation-safe).
3. Arena client: orbs, scoreboard, timer, banner, rematch.
4. Smoke: two sockets start a round and A’s collect is visible on B.
5. Two-tab full round + screenshot/video on PR #8.

## Stack

Workers + Static Assets + Durable Objects (SQLite class, Hibernation API) + Rate Limiting. Bun-bundled Three.js. No Vite/Hono/React.

## Architecture

```
browser ──HTTPS──> Worker
                    ├─ POST /api/rooms ──► CREATE_LIMIT
                    └─ GET  /ws/:room ──► VibeRoom
                                           ├─ attachments: pose + score
                                           ├─ storage: round / orbs
                                           └─ alarm: countdown + 75s clock
```

## Testing

- `bun run typecheck` + `scripts/smoke.ts`
- Two tabs play a full round (start, collect, scoreboard, rematch)
- Screenshot + video on the PR
