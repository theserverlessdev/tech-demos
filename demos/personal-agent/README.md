# Personal agent

An anonymous personal assistant on Cloudflare Workers. This is a **small demo** inspired by [DomWane/workers-personal-agent](https://github.com/DomWane/workers-personal-agent) by DomWane (MIT), not a fork of that app. The post that pointed at the upstream repo is [on X](https://x.com/tonycasavan/status/2101803028315537806).

- **Live:** <https://tech-demos.theserverless.dev/demos/personal-agent/>
- **Subdomain:** <https://personal-agent.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

## What this demonstrates

**Pattern.** One Agents SDK Durable Object per anonymous visitor holds the thread and embedding vectors. A Durable Object is created on the first Turnstile-gated write. Page views, unsigned GETs, and GETs with an expired token do not create one. Markdown notes live in R2 under that visitor's prefix. Research fetches 2–4 allowlisted https pages. An alarm deletes that visitor's R2 files and Durable Object storage 24 hours after the last write.

**What you can do**

- Chat with the assistant bound to this browser's visitor id.
- Create, open, and delete markdown notes in R2.
- See the note title and score under a reply that used memory.
- Run research over 2–4 allowlisted pages, or leave the URL list empty to use the docs catalog, and read the citations.
- Start a new visitor, which is a different Durable Object.

**What you could build**

- A notes-backed assistant for one person, with no account.
- A research sidebar that only fetches an allowlist.
- A demo tenant that deletes its own storage on a timer (`destroy()` plus the R2 prefix).

**Limits**

- No third-party model key. If Workers AI fails, keyword overlap (at least two matched words) still recalls notes and the reply falls back to an excerpt.
- Embeddings use the first 1000 characters of a note. The keyword fallback keeps the first 12 distinct words. Facts later in a long note may not be recalled.
- GLM-5.3 Flash cannot turn reasoning off. The Worker sends `reasoning_effort: "low"` and `max_completion_tokens: 1500`. If the model still returns empty content, the reply is the local fallback. Local `wrangler dev` and the committed screenshots show that fallback. A live paid Workers AI call was not run and would not by itself prove those settings.
- Research will not fetch private addresses or IP literals, and it caps size and time. Oversize pages are truncated, not rejected.
- Turnstile is required on chat, research, and note writes. A missing secret fails closed.

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Agents SDK Durable Object** | One SQLite-backed assistant per anonymous visitor. The visitor id in `localStorage` is the Durable Object name. The first write returns an HMAC-signed `id.exp.sig` token. Later reads send it as `x-visitor-token`. The thread lives in that Durable Object. |
| **R2** | Markdown notes under `v/<visitorId>/`. Create, view, and delete. |
| **Workers AI** | Chat replies and `bge-small-en-v1.5` embeddings. Cosine recall runs in the Durable Object (semantic floor 0.58). If the binding fails, two-keyword overlap still recalls notes and the reply falls back to an excerpt. |
| **Rate limits** | `CHAT_LIMIT` on chat and note writes, `RESEARCH_LIMIT` on research, `READ_LIMIT` on reads. IPv6 is keyed on its /64. |
| **Turnstile** | Required on chat, research, and note writes. Missing `TURNSTILE_SECRET` fails closed. |
| **Durable Object alarm** | Agents SDK `schedule()` (it owns the alarm slot) deletes that visitor's R2 prefix and then `destroy()`s the Durable Object 24 hours after the last write. |

The chat shows the note title and score under each reply that used memory. Research fans out 2–4 target URLs against an https host allowlist (each target may follow up to two redirects; size cap, time cap, no private addresses, no IP literals) and cites the URLs.

There is no account and no third-party API key. The visitor id is the capability for that Durable Object. Reads send the signed token in the `x-visitor-token` header, not the query string. Query strings are redacted in Workers Logs. The header name includes `token` so Workers Logs redacts it.

## How it works

```text
browser ── HTTPS JSON + x-visitor-token ──► Worker (rate limit + Turnstile)
                                           └─ first write mints HMAC id.exp.sig token
                                           └─ Assistant Durable Object
                                                ├─ chat / embeddings ─► Workers AI
                                                ├─ markdown notes ───► R2  v/<visitorId>/
                                                ├─ thread + vectors ─► DO SQLite
                                                └─ research ─────────► 2–4 allowlisted fetches
```

## Local

```bash
cd demos/personal-agent
cp .dev.vars.example .dev.vars
bun install
bun run test
bun run dev
```

`.dev.vars` holds Cloudflare's [always-pass Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/), `ENVIRONMENT=local`, and the local-only `VISITOR_HMAC_SECRET`. The widget token for those keys is `XXXX.DUMMY.TOKEN.XXXX`. `wrangler dev` rewrites the Host header to the first production route, so the test secret is accepted only when `ENVIRONMENT` is `local`. A request that only looks like localhost (for example `Host: localhost:8790` with no `ENVIRONMENT`) is still rejected. Production `wrangler.jsonc` leaves `ENVIRONMENT` empty, and the Worker rejects the test secret and the local HMAC key there.

`bun run typecheck` runs `wrangler types` before `tsc`, so a clean clone does not need a committed `worker-configuration.d.ts`. `TURNSTILE_SECRET` and `VISITOR_HMAC_SECRET` are listed under `secrets.required`, which is what puts them on `Env`.

Then, in another shell:

```bash
bun run scripts/smoke.ts http://127.0.0.1:8787
```

The test secret is refused when `ENVIRONMENT` is not `local`. A deployed Worker with no `TURNSTILE_SECRET` or `VISITOR_HMAC_SECRET` returns 503 on chat, research, and note writes.

## Deploy

Live Worker `tech-demos-personal-agent`. The R2 bucket `tech-demos-personal-agent` exists. `TURNSTILE_SITE_KEY` in `wrangler.jsonc` is the public widget key. `TURNSTILE_SECRET` and `VISITOR_HMAC_SECRET` are Worker secrets (never commit them).

Rate-limit namespace ids are `7510` (chat and note writes), `7511` (research), and `7512` (reads). Those do not overlap main (`7301`–`7331`, `7341`–`7344`, `7351`–`7353`, `7361`–`7364`, `7371`–`7374`, `7381`–`7384`, `7391`–`7394`, `7411`–`7412`, `7421`, `7431`–`7434`, `7451`–`7453`, `7461`–`7464`).

To rotate secrets or redeploy, from this folder, with the owner account (unset any other `CF_API_TOKEN`):

```bash
cd demos/personal-agent
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put TURNSTILE_SECRET
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put VISITOR_HMAC_SECRET
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

Do not put the always-pass test secret or the committed local HMAC key in production. The Worker rejects those unless `ENVIRONMENT` is `local`.

Routes:

- `tech-demos.theserverless.dev/demos/personal-agent*`
- `personal-agent.tech-demos.theserverless.dev/*`

After the Worker is deployed, redeploy `apps/hub` so the gallery card is registered. The hub entry is a fallback redirect to the subdomain. The zone route is what serves the demo under `/demos/personal-agent/`.

## Secrets

| Name | Where | What |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | wrangler var (public) | Shared widget site key `0x4AAAAAAFRUoj5qDpf7XyIW`. Local `.dev.vars` overrides it with `1x00000000000000000000AA`. |
| `TURNSTILE_SECRET` | `wrangler secret put` | Siteverify secret. Local `.dev.vars` uses `1x0000000000000000000000000000000AA`. |
| `VISITOR_HMAC_SECRET` | `wrangler secret put` | Signs `id.exp.sig` visitor tokens. Local `.dev.vars` uses `local-personal-agent-hmac-dev-only`, which production rejects. |

No other secrets. Workers AI uses the platform binding.
