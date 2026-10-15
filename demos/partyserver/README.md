# Partyboard

A shared ink board on Cloudflare Workers. This is a **small demo** inspired by [cloudflare/partykit](https://github.com/cloudflare/partykit) (PartyServer and Y-PartyServer), not a fork of that monorepo.

- **Upstream:** [cloudflare/partykit](https://github.com/cloudflare/partykit) — Sunil Pai (threepointone) and Cloudflare contributors. License: **ISC**.
- **Prompt:** [@_thebluebutter](https://x.com/_thebluebutter/status/2105331683000234478)
- **Live:** <https://tech-demos.theserverless.dev/demos/partyserver/>
- **Subdomain:** <https://partyserver.tech-demos.theserverless.dev/> (same Worker)
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What this demonstrates

**Pattern.** PartyServer routes each ink room to one hibernating `BoardRoom` Durable Object. Yjs strokes persist in Durable Object storage. Cursors stay on the awareness channel and are not stored. An alarm runs `deleteAll` two hours after the room is created.

**What you can do**

- Open a room after the Turnstile check and send the link.
- Draw and watch the stroke sync to another tab. Ink uses a 4:3 logical board, so a circle on a desktop stays a circle on a phone.
- See live cursors that disappear when the socket closes.
- Hit the caps: 8 connections, 240 strokes, and a 256 KB snapshot. Erasing reopens a full board. A 9th visitor and an expired room show the real reason, not "Reconnecting…".

**What you could build**

- A collaborative whiteboard that deletes itself.
- Live annotation on a shared page.
- A classroom sketch room with a hard cap on size and time.

**Limits**

- Display names ride awareness only. They are not written to Durable Object storage.
- Creating a room needs Turnstile and `CREATE_LIMIT`. Opening a socket needs `CONNECT_LIMIT`. Status lookups need `READ_LIMIT`. Room ids are HMAC-tagged with `TURNSTILE_SECRET` so a forged id never wakes a Durable Object.
- This is a small board inspired by PartyKit, not a fork of that monorepo.

## What it proves

| Piece | What the demo does with it |
| --- | --- |
| **PartyServer** | One `BoardRoom` Durable Object per ink room. WebSocket hibernation is on. `routePartykitRequest` serves `/parties/board-room/:id`. HTTP through that router 404s; the Worker talks to the DO with `getServerByName`. |
| **Y-PartyServer** | Strokes live in a Yjs map. `onLoad` / `onSave` keep the snapshot in Durable Object storage. Cursors use the awareness channel and are not stored. `isReadOnly` stays false so erases still sync. |
| **Alarm** | Two hours after create, the alarm runs `deleteAll` (which also clears the alarm on compat date `2026-09-01`) and closes every socket. Unknown rooms that wake without `meta` also `deleteAll`, so partyserver's `__ps_name` row is not billed. |
| **Caps** | 8 connections, 240 strokes, 256 KB snapshot, and a per-connection frame meter. A server `afterTransaction` guard drops invalid keys and extras; a rejected 9th socket cannot write. |
| **Turnstile + rate limits** | Creating a room needs a server-side Turnstile check and `CREATE_LIMIT` (7500). Opening a socket needs a valid HMAC id and `CONNECT_LIMIT` (7501). Status GET needs `READ_LIMIT` (7502). |

The UI is Graphite & Ember (ember `#c2410c`, background `#0e0e11`, Bricolage Grotesque and Hanken Grotesk). **Contact** goes to <https://theserverless.dev/contact>.

Display names never go to Durable Object storage. They ride the awareness channel for as long as the socket is open.

## How it works

```text
browser ── POST /api/rooms ──► Turnstile + CREATE_LIMIT ──► HMAC id ──► BoardRoom init + alarm
browser ── GET  /api/rooms/:id ──► READ_LIMIT + HMAC ──► status (deleteAll if no meta)
browser ── WebSocket /parties/board-room/:id ──► HMAC + CONNECT_LIMIT ──► Yjs sync
BoardRoom ── onSave / last close ──► DO storage key "yjs"
alarm ──► deleteAll, close sockets
```

Packages, checked for this PR: `partyserver` 0.5.10 and `y-partyserver` 2.2.0 are ISC (cloudflare/partykit). `partysocket` 1.3.0 and `yjs` 13.6.33 are MIT.

## Local

```bash
cd demos/partyserver
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

`.dev.vars.example` holds Cloudflare's published always-pass Turnstile test pair plus `TURNSTILE_LOCAL=1`. Wrangler dev rewrites `Host` to the production route, so that flag (not the hostname) is what allows the test pair. Production `wrangler.jsonc` leaves `TURNSTILE_LOCAL` at `"0"`. A deploy with the test secret, an empty secret, or no site key fails closed. Room ids are tagged with HMAC-SHA256 of that same `TURNSTILE_SECRET`.

Then, in another terminal:

```bash
bun test demos/partyserver
bun run scripts/smoke.ts http://127.0.0.1:8787
```

## Deploy

Live at <https://tech-demos.theserverless.dev/demos/partyserver/>.

`vars.TURNSTILE_SITE_KEY` is the production widget key. `TURNSTILE_SECRET` is listed under `secrets.required` so types include it; the value stays a Worker secret. Rate-limit namespace ids are `7500` (create), `7501` (connect), and `7502` (status read). No D1 or R2. The Durable Object class and those bindings are declared in `wrangler.jsonc`.

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

- `tech-demos.theserverless.dev/demos/partyserver`
- `tech-demos.theserverless.dev/demos/partyserver/*`
- `partyserver.tech-demos.theserverless.dev/*`

Redeploy `apps/hub` if the gallery card is missing. The registry fallback redirects to the subdomain if the zone route is missing.

## Owner steps

This PR does not deploy and does not call the Cloudflare API. After merge, from the owner account:

1. Redeploy this Worker (`wrangler deploy` as above). That picks up `READ_LIMIT` (7502), the new create/connect ids (7500/7501), the split hub routes, and HMAC room ids. `TURNSTILE_SECRET` is already set; it is also the HMAC key. No new secret, no D1, no R2, no new Durable Object class.
2. Redeploy `apps/hub` so the gallery card matches the copy in `registry.ts`.
3. Rooms created before this deploy become invalid (id length + HMAC). They expire in two hours either way.

`bun run typecheck` runs `wrangler types` before `tsc`, so a clean clone does not need a committed `worker-configuration.d.ts`.
