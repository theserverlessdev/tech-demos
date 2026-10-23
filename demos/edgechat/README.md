# EdgeChat slice

A mini self-hosted team chat on Cloudflare Workers. This is a **small original demo** inspired by [aozorae/Edgechat](https://github.com/aozorae/Edgechat), not a fork of that app.

Upstream is **GPL-3.0**. This folder is original code under the same license as this monorepo. We did not copy, vendor, or reconstruct Edgechat source, assets, or substantial structure.

- **Live:** <https://tech-demos.theserverless.dev/demos/edgechat/>
- **Subdomain:** <https://edgechat.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs the idea:** [CHANGELOG.md](./CHANGELOG.md)

## What this demonstrates

**Pattern.** One `ChatRoom` Durable Object per room name fans out hibernating WebSockets. The object sleeps between messages while visitors stay connected. D1 keeps the transcript across refresh, KV stores the display name, and R2 holds an attachment the message can link to.

**What you can do**

- Join the same room in two tabs and watch a message arrive in both.
- Refresh and still see the last 80 messages stored in D1.
- Set a display name stored in KV.
- Attach a file. The message links to the R2 object, and PNG/JPEG/GIF/WebP images preview.

**What you could build**

- An incident channel whose transcript survives a refresh.
- In-product comments with file drops.
- A support room that sleeps between messages while visitors stay connected.

**Limits**

- Presence is a connection-count stub, not a full member directory.
- This is original code inspired by Edgechat, not a fork of that GPL app.
- There is no account system. The display name is a KV session cookie (`publicId` is public; the cookie value is not).
- Room ids are slugs of letters and numbers (any script). Punctuation-only names are rejected.
- Messages and `uploads/` objects older than 7 days are pruned (newest 500 per room are kept). Seed lobby rows stay.
- The socket reconnects with backoff after a drop, a deploy, or when the tab becomes visible again.
- Writes (REST and WebSocket) share a per-IP and per-session limit. Uploads are 1 MB and sit under a daily byte budget. Turnstile gates minting a session.

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Durable Objects** | One `ChatRoom` per room name. Hibernatable WebSockets broadcast messages and sleep between them while sockets stay connected. Presence is a connection-count stub that drops on leave. |
| **D1** | Rooms and message history. Persist on send; load on join. Survives refresh. Hourly TTL prune. |
| **KV** | Display-name session cookie plus a non-secret `publicId`. |
| **R2** | Attach a file in a room under `uploads/`; the message shows a link (PNG/JPEG/GIF/WebP preview). |
| **Turnstile** | One solve mints a KV session. Upload, room create, and WS upgrade need that session. |
| **Rate Limit** | `WRITE_LIMIT` (40/60s) on REST and socket sends, per IP **and** per session. `CONNECT_LIMIT` (7468, 40/60s) on upgrades. |

The UI is a room picker, a scrolling message list, a composer, and an upload control. Graphite & Ember branding matches the hub (ember `#c2410c`, background `#0e0e11`, LogoMark SVG). Mobile-fluid at 390px.

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ GET  /api/session ─────────► cookie peek (no KV write)
                      ├─ POST /api/session ─────────► Turnstile + KV
                      ├─ GET  /api/rooms* ──────────► D1 read (404 if missing)
                      ├─ POST rooms / send / upload ► rate limit + session + D1/R2
                      ├─ /api/files/:id ────────────► D1 meta + R2 bytes
                      └─ GET /ws/:room ─────────────► Origin + CONNECT_LIMIT + session
                                                        ChatRoom Durable Object
                                                        ├─ WRITE_LIMIT + socket bucket
                                                        ├─ persist on send ──► D1
                                                        └─ hibernatable WS fan-out
cron (hourly) ──► prune old D1 rows + R2 uploads
```

Cloudflare resources are prefixed `tech-demos-edgechat-*` (Worker, D1, KV, R2) so they do not collide with other demos in this repo.

## Local

```bash
cd demos/edgechat
bun install
bun run dev
```

Then `bun test` and `bun run scripts/smoke.ts http://127.0.0.1:8787`.

`bun run dev` writes `.dev.vars` with Cloudflare's always-pass Turnstile test pair (if missing) and sets `CI=1` so D1 migrations apply without a prompt.

Open two browser tabs on the same room. Send a message in one; the other should show it without a refresh. Refresh either tab — D1 history should still be there. Attach a PNG — it should preview. On a 390px-wide viewport the room list is a horizontal chip row and the message pane scrolls in place.

The hub path and the demo's own `wrangler dev` both work. From the repo root you can also run `bun run --filter @tech-demos/hub dev` and hit the gallery; this demo is a standalone Worker, so for the full bindings use `bun run --filter @tech-demos/edgechat dev`.

## Deploy

Needs D1, KV, R2, Durable Objects, and a Turnstile widget (Workers Paid). From this folder, with the owner account (`CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5`; unset any other `CF_API_TOKEN` / `CLOUDFLARE_API_TOKEN` if they point at the wrong account):

```bash
cd demos/edgechat
CI=1 bun run deploy
```

This pass does **not** create Cloudflare resources or deploy. Existing ids stay in `wrangler.jsonc`.

Owner steps after merge:

1. `wrangler d1 migrations apply DB --remote` (or `bun run deploy`) so migrations `0002` and `0003` land.
2. Reuse the shared Turnstile widget (`docs/turnstile.md`). The site key is already in `wrangler.jsonc`. Run `wrangler secret put TURNSTILE_SECRET` with that widget's secret. `wrangler deploy` fails if the secret is missing (`secrets.required`).
3. Optional but recommended: R2 lifecycle on bucket `tech-demos-edgechat`, prefix `uploads/`, expire after 7 days. That leaves `seed/welcome.txt` alone. Dashboard or `wrangler r2 bucket lifecycle` — this agent does not change Cloudflare account config.
4. Confirm `CONNECT_LIMIT` namespace `7468` is unused by another Worker on the same account.

Routes:

- `tech-demos.theserverless.dev/demos/edgechat*`
- `edgechat.tech-demos.theserverless.dev/*`

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.
