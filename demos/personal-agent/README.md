# Personal agent

An anonymous personal assistant on Cloudflare Workers. This is a **small demo** inspired by [DomWane/workers-personal-agent](https://github.com/DomWane/workers-personal-agent) by DomWane (MIT), not a fork of that app. The post that pointed at the upstream repo is [on X](https://x.com/tonycasavan/status/2101803028315537806).

- **Hub path:** <https://tech-demos.theserverless.dev/demos/personal-agent/>
- **Subdomain:** <https://personal-agent.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Agents SDK Durable Object** | One SQLite-backed assistant per anonymous visitor. The visitor id in `localStorage` is the Durable Object name. The thread lives there. |
| **R2** | Markdown notes under `v/<visitorId>/`. Create, view, and delete. |
| **Workers AI** | Chat replies and `bge-small-en-v1.5` embeddings. Cosine recall runs in the Durable Object. If the binding fails, keyword overlap still recalls notes and the reply falls back to an excerpt. |
| **Rate limits** | `CHAT_LIMIT` on chat and note writes, `RESEARCH_LIMIT` on research, `READ_LIMIT` on reads. |
| **Turnstile** | Required on chat, research, and note writes. Missing `TURNSTILE_SECRET` fails closed. |
| **Durable Object alarm** | Agents SDK `schedule()` (it owns the alarm slot) deletes that visitor's SQLite rows and R2 prefix 24 hours after the last write. |

The chat shows the note title and score under each reply that used memory. Research fans out 2–4 fetches against an https host allowlist (size cap, time cap, no private addresses, no IP literals) and cites the URLs.

There is no account and no third-party API key. The visitor id is the capability for that Durable Object. It is not written to logs.

## How it works

```text
browser ── HTTPS JSON ──► Worker (rate limit + Turnstile)
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
bun run dev
```

`.dev.vars` holds Cloudflare's [always-pass Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/). The widget token for those keys is `XXXX.DUMMY.TOKEN.XXXX`.

Typecheck needs generated bindings (`worker-configuration.d.ts` is gitignored):

```bash
bun run cf-typegen
bun run typecheck
```

Then, in another shell:

```bash
bun run scripts/smoke.ts http://127.0.0.1:8787
```

The test secret is refused when the request host is not localhost. A deployed Worker with no `TURNSTILE_SECRET` returns 503 on chat, research, and note writes.

## Deploy

Needs R2, a SQLite Durable Object, Workers AI, rate-limit bindings, and Turnstile (Paid). From this folder, with the owner account (unset any other `CF_API_TOKEN`):

```bash
cd demos/personal-agent
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler whoami
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler r2 bucket create tech-demos-personal-agent
```

Create a Turnstile widget whose hostnames are `tech-demos.theserverless.dev`, `personal-agent.tech-demos.theserverless.dev`, and the `workers.dev` hostname. Put the public site key in `wrangler.jsonc` as `TURNSTILE_SITE_KEY`. Set the secret:

```bash
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put TURNSTILE_SECRET
```

Do not put the always-pass test secret in production. The Worker rejects that secret off localhost.

```bash
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

Routes:

- `tech-demos.theserverless.dev/demos/personal-agent*`
- `personal-agent.tech-demos.theserverless.dev/*`

After the Worker is deployed, redeploy `apps/hub` so the gallery card is registered. The hub entry is a fallback redirect to the subdomain. The zone route is what serves the demo under `/demos/personal-agent/`.

## Secrets

| Name | Where | What |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | wrangler var (public) | Widget site key. Empty in git. Local `.dev.vars` uses `1x00000000000000000000AA`. |
| `TURNSTILE_SECRET` | `wrangler secret put` | Siteverify secret. Local `.dev.vars` uses `1x0000000000000000000000000000000AA`. |

No other secrets. Workers AI uses the platform binding.
