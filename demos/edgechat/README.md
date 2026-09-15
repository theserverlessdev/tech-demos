# EdgeChat slice

A mini self-hosted team chat on Cloudflare Workers. This is a **small original demo** inspired by [aozorae/Edgechat](https://github.com/aozorae/Edgechat), not a fork of that app.

Upstream is **GPL-3.0**. This folder is original code under the same license as this monorepo. We did not copy, vendor, or reconstruct Edgechat source, assets, or substantial structure.

- **Live:** <https://tech-demos.theserverless.dev/demos/edgechat/>
- **Subdomain:** <https://edgechat.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs the idea:** [CHANGELOG.md](./CHANGELOG.md)

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Durable Objects** | One `ChatRoom` per room name. Hibernatable WebSockets broadcast messages. Presence is a connection-count stub. |
| **D1** | Rooms and message history. Persist on send; load on join. Survives refresh. |
| **KV** | Display-name session cookie. |
| **R2** | Attach a file in a room; the message shows a link (and an image preview when the type is an image). |

The UI is a room picker, a message list, a composer, and an upload control. Graphite & Ember branding matches the hub (ember `#c2410c`, background `#0e0e11`, LogoMark SVG).

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ /api/session ──────────────► KV
                      ├─ /api/rooms* ───────────────► D1
                      ├─ /api/files/:id ────────────► D1 meta + R2 bytes
                      ├─ POST upload / REST send ───► D1 + R2, then DO broadcast
                      └─ GET /ws/:room ─────────────► ChatRoom Durable Object
                                                        ├─ persist on send ──► D1
                                                        └─ hibernatable WS fan-out
```

Cloudflare resources are prefixed `tech-demos-edgechat-*` (Worker, D1, KV, R2) so they do not collide with other demos in this repo.

## Local

```bash
cd demos/edgechat
bun install
bun run dev
```

Then `bun run scripts/smoke.ts http://127.0.0.1:8787`.

Open two browser tabs on the same room. Send a message in one; the other should show it without a refresh. Refresh either tab — D1 history should still be there. Attach a file — the message should link to R2.

The hub path and the demo's own `wrangler dev` both work. From the repo root you can also run `bun run --filter @tech-demos/hub dev` and hit the gallery; this demo is a standalone Worker, so for the full bindings use `bun run --filter @tech-demos/edgechat dev`.

## Deploy

Needs D1, KV, R2, and Durable Objects (Workers Paid). From this folder, with the owner account (`CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5`; unset any other `CF_API_TOKEN` / `CLOUDFLARE_API_TOKEN` if they point at the wrong account):

```bash
wrangler d1 create tech-demos-edgechat
wrangler kv namespace create tech-demos-edgechat-sessions
wrangler r2 bucket create tech-demos-edgechat
# put the D1 id and KV id into wrangler.jsonc, then:
bun run deploy
```

This PR already created:

- D1 `tech-demos-edgechat` (`7c3de818-470f-445a-90c7-399d03c686c3`)
- KV `tech-demos-edgechat-sessions` (`42b3d8c6974d464a97d0d55079a0fb71`)
- R2 `tech-demos-edgechat`

Routes:

- `tech-demos.theserverless.dev/demos/edgechat*`
- `edgechat.tech-demos.theserverless.dev/*`

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.
