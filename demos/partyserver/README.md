# Partyboard

A shared ink board on Cloudflare Workers. This is a **small demo** inspired by [cloudflare/partykit](https://github.com/cloudflare/partykit) (PartyServer and Y-PartyServer), not a fork of that monorepo.

- **Upstream:** [cloudflare/partykit](https://github.com/cloudflare/partykit) — Sunil Pai (threepointone) and Cloudflare contributors. License: **ISC**.
- **Prompt:** [@_thebluebutter](https://x.com/_thebluebutter/status/2105331683000234478)
- **Live:** <https://tech-demos.theserverless.dev/demos/partyserver/>
- **Subdomain:** <https://partyserver.tech-demos.theserverless.dev/> (same Worker)
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What it proves

| Piece | What the demo does with it |
| --- | --- |
| **PartyServer** | One `BoardRoom` Durable Object per ink room. WebSocket hibernation is on. `routePartykitRequest` serves `/parties/board-room/:id`. |
| **Y-PartyServer** | Strokes live in a Yjs map. `onLoad` / `onSave` keep the snapshot in Durable Object storage. Cursors use the awareness channel and are not stored. |
| **Alarm** | Two hours after create, the alarm deletes storage and closes every socket. |
| **Caps** | 8 connections, 240 strokes, 256 KB snapshot, and a per-connection frame meter. |
| **Turnstile + rate limits** | Creating a room needs a server-side Turnstile check and `CREATE_LIMIT`. Opening a socket needs `CONNECT_LIMIT`. |

The UI is Graphite & Ember (ember `#c2410c`, background `#0e0e11`, Bricolage Grotesque and Hanken Grotesk). **Contact** goes to <https://theserverless.dev/contact>.

Display names never go to Durable Object storage. They ride the awareness channel for as long as the socket is open.

## How it works

```text
browser ── POST /api/rooms ──► Turnstile + CREATE_LIMIT ──► BoardRoom init + alarm
browser ── WebSocket /parties/board-room/:id ──► CONNECT_LIMIT ──► Yjs sync
BoardRoom ── onSave / last close ──► DO storage key "yjs"
alarm ──► deleteAll + dead flag, close sockets
```

Packages, checked for this PR: `partyserver` 0.5.10 and `y-partyserver` 2.2.0 are ISC (cloudflare/partykit). `partysocket` 1.3.0 and `yjs` 13.6.33 are MIT.

## Local

```bash
cd demos/partyserver
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

`.dev.vars.example` holds Cloudflare's published always-pass Turnstile test pair plus `TURNSTILE_LOCAL=1`. Wrangler dev rewrites `Host` to the production route, so that flag (not the hostname) is what allows the test pair. Production `wrangler.jsonc` leaves `TURNSTILE_LOCAL` at `"0"`. A deploy with the test secret, an empty secret, or no site key fails closed.

Then, in another terminal:

```bash
bun run scripts/smoke.ts http://127.0.0.1:8787
```

## Deploy

Live at <https://tech-demos.theserverless.dev/demos/partyserver/>.

`vars.TURNSTILE_SITE_KEY` is the production widget key. `TURNSTILE_SECRET` is listed under `secrets.required` so types include it; the value stays a Worker secret. Rate-limit namespace ids stay `7411` (create) and `7412` (connect). No D1 or R2. The Durable Object class and those bindings are declared in `wrangler.jsonc`.

Redeploy from the owner account (unset any other `CF_API_TOKEN`):

```bash
cd demos/partyserver
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

Test credentials (local only):

| | Value |
| --- | --- |
| Site key | `1x00000000000000000000AA` |
| Secret | `1x0000000000000000000000000000000AA` |
| Dummy token | `XXXX.DUMMY.TOKEN.XXXX` |

Routes:

- `tech-demos.theserverless.dev/demos/partyserver*`
- `partyserver.tech-demos.theserverless.dev/*`

Redeploy `apps/hub` if the gallery card is missing. The registry fallback redirects to the subdomain if the zone route is missing.

## Owner steps

The Worker is already deployed. The site key is in `wrangler.jsonc`. `TURNSTILE_SECRET` was set with `wrangler secret put` and is not in git.

`bun run typecheck` runs `wrangler types` before `tsc`, so a clean clone does not need a committed `worker-configuration.d.ts`.

After a later Worker deploy, redeploy `apps/hub` so the gallery card stays on the hub.
