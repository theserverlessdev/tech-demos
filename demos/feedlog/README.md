# Feedlog slice

A public feedback board on Cloudflare Workers. This is a **small demo** inspired by [linkcraftstudio/feedlog](https://github.com/linkcraftstudio/feedlog) (MIT, by linkcraftstudio), not a fork of that app. The note that pointed at it: [on X](https://x.com/ceoplanet519/status/2087056479459119500).

- **Live:** not deployed from this environment (no Cloudflare credentials). Intended URL: <https://tech-demos.theserverless.dev/demos/feedlog/>
- **Subdomain:** <https://feedlog.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **D1** | Posts, one vote per visitor, changelog entries. Five seeded ideas plus two changelog entries. Visitor posts expire after 14 days. |
| **R2** | Optional JPEG, PNG, GIF, or WebP on a post. 1.5 MB cap. The bytes have to match the declared type. |
| **Workers AI** | `@cf/baai/bge-small-en-v1.5` embeds the title and body (384 dimensions). |
| **Vectorize** | Cosine index `tech-demos-feedlog`. Similar posts while you type. Vectors are deleted when the post expires. |
| **Rate limits** | Separate limits for new posts, votes, similarity checks, and admin writes. |
| **Turnstile** | Required before a post, an upload, or a similarity check. |
| **Cron** | Hourly sweep deletes expired visitor posts, their votes, their R2 objects, and their vectors. |

If Workers AI or Vectorize throws (local dev has no Vectorize simulation), similarity falls back to word overlap and the page says so. That path is labeled `lexical`. It is not the production index.

The UI is Graphite & Ember: background `#0e0e11`, ember `#c2410c`, Bricolage Grotesque and Hanken Grotesk. **Contact** goes to [theserverless.dev/contact](https://theserverless.dev/contact).

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ /api/posts, votes, changelog ─► D1
                      ├─ images ──────────────────────► R2
                      ├─ /api/similar and index ──────► Workers AI → Vectorize
                      └─ admin status / changelog ────► ADMIN_TOKEN

cron (hourly) ──► delete expired posts, R2 objects, vectors
```

Hash routes (`#/board`, `#/roadmap`, `#/changelog`) keep asset URLs relative, so the same build works at `/demos/feedlog/` and at the subdomain root.

Anonymous visitors get an HttpOnly `fl_vid` cookie. It is a random id, not an account. Display names that contain `@` are rejected. Logs do not include the cookie, the admin token, or the Turnstile token.

A Turnstile pass mints a 10-minute `fl_gate` cookie so the debounced duplicate check does not spend a one-time token on every keystroke. Creating a post still requires that gate or a fresh token.

## Local

```bash
cd demos/feedlog
bun install
bun run dev
```

Local `wrangler dev --local` does not open a remote proxy. `bun run dev` writes `.dev.vars` (gitignored) with Cloudflare’s always-pass Turnstile test keys and the local admin token `dev-feedlog-admin`. Wrangler serves the zone route host even on your machine, so those values are what open writes locally. Workers AI and Vectorize have no local simulation in this Wrangler, so similarity answers with word overlap until the Worker is deployed. The compatibility date is `2026-09-10` because the Wrangler pinned in this repo (4.129) rejects anything newer.

```bash
bun run scripts/smoke.ts http://127.0.0.1:8787
```

On `127.0.0.1` / `localhost` only, when the secrets are unset:

- Turnstile uses Cloudflare’s always-pass test site key `1x00000000000000000000AA` and secret `1x0000000000000000000000000000000AA`.
- The admin token is `dev-feedlog-admin`.

Any other host fails closed until `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY`, and `ADMIN_TOKEN` are set. Do not ship the loopback token.

`scripts/smoke.ts` sends the documented dummy token `XXXX.DUMMY.TOKEN.XXXX`. Against a production widget that token will fail, which is what you want. Pass `ADMIN_TOKEN` in the environment if you point smoke at a deployed Worker.

## Owner steps to deploy

This environment’s `wrangler whoami` was not authenticated. The D1 id in `wrangler.jsonc` is a placeholder. Nothing was deployed.

From `demos/feedlog`, with the owner account (unset any other API token):

```bash
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler whoami

env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler d1 create tech-demos-feedlog
# paste the database_id over the placeholder in wrangler.jsonc

env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler r2 bucket create tech-demos-feedlog

env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler vectorize create tech-demos-feedlog --dimensions=384 --metric=cosine

# Widget hostnames: tech-demos.theserverless.dev and feedlog.tech-demos.theserverless.dev
# Add the public site key under vars in wrangler.jsonc:
#   "TURNSTILE_SITE_KEY": "<widget site key>"
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put TURNSTILE_SECRET
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put ADMIN_TOKEN

env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bun run deploy
```

Then redeploy the hub (`apps/hub`) so the gallery card is the new registry entry. The zone route already wins when it exists. The registry source only redirects to the subdomain if that route is missing.

Routes:

- `tech-demos.theserverless.dev/demos/feedlog*`
- `feedlog.tech-demos.theserverless.dev/*`

Rate-limit namespace ids are `7341`–`7344`. They are created with the Worker. Workers AI has to be available on the Paid account. The embedding model and the index are both 384 dimensions. Changing the model means creating a new index.
