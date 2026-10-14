# BYOK playground

A bring-your-own-key AI playground. Paste an OpenAI-compatible API key, base URL, and model id. The Worker proxies `/chat/completions` and `/models` without storing the key.

- **Live (after deploy):** <https://tech-demos.theserverless.dev/demos/byok-playground/>
- **Subdomain:** <https://byok-playground.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What this demonstrates

**Pattern.** A Worker can proxy a visitor’s OpenAI-compatible key without becoming an open proxy. The key lives in the browser (`sessionStorage` by default, opt-in Remember on `localStorage`). Each request sends it in a header. The Worker never logs, stores, or echoes it. SSRF is blocked, redirects are refused, and Workers AI comparison is Turnstile-gated with an atomic D1 daily budget.

**What you can do**

- Paste a key, an https base URL, and a model id, then stream a chat.
- List models from `GET /models`.
- Send the same prompt to your model and to Workers AI. Read latency, time to first token, and tokens where the endpoint reports them.
- Probe streaming, tools / function calling, JSON schema `response_format`, and vision. Each check is pass, fail, or unsupported, with the raw error (key stripped).

**What you could build**

- A product that accepts a customer’s OpenAI-compatible key without writing it to disk.
- A migration bench that compares a provider against Workers AI on the same prompt.
- An eval harness that records which capabilities an endpoint actually implements.

**Limits**

- Only `/chat/completions` and `/models` under the pasted base. https only (`http://localhost` under `wrangler dev`).
- No redirects. Hop-by-hop headers and cookies are stripped. Visitor cookies are never forwarded.
- Compare spends the shared Workers AI budget and requires Turnstile.
- Local `bun run dev` omits the Workers AI binding and uses a labelled stub.

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Workers + Static Assets** | Serves the playground and the proxy API from one Worker. |
| **SSRF guard** | Blocks private, loopback, link-local, CGNAT, metadata, and internal hostnames, including decimal / octal / hex / mapped forms. |
| **Rate limiting** | Chat `7461`, models `7462`, compare `7463`, per IP. |
| **Turnstile** | Required on the Workers AI comparison path. Fails closed without a real secret off localhost. |
| **D1** | Atomic daily compare budget. Rows store an HMAC’d `ip_key`, never the address. |
| **Workers AI** | The “ours” side of compare. Local wrangler config stubs it. |

## How it works

```text
browser (sessionStorage) ── x-byok-key ──► Worker
                                            ├─ same-origin + session cookie
                                            ├─ SSRF + path allowlist
                                            ├─ POST /chat/completions  (SSE passthrough)
                                            ├─ GET  /models
                                            └─ compare ─ Turnstile + D1 budget ─ Workers AI
```

Cloudflare resources are prefixed `tech-demos-byok-playground` so they do not collide with other demos in this repo.

## Local

```bash
cd demos/byok-playground
cp .dev.vars.example .dev.vars
bun install
bun run mock          # OpenAI-compatible mock on :8799
bun run dev           # Worker on :8787
```

`.dev.vars` holds Cloudflare’s published always-pass Turnstile test secret (`1x0000000000000000000000000000000AA`) and a local `IP_HASH_SECRET`. `wrangler.local.jsonc` uses the matching test site key.

In the UI:

- API key: any string (the mock does not check it)
- Base URL: `http://127.0.0.1:8799/v1`
- Model: `mock-gpt`

Then, with the Worker up:

```bash
bun test
bun run typecheck
bun run scripts/smoke.ts http://127.0.0.1:8787
```

## Secrets and deploy needs

Do **not** deploy from this PR unless the owner asks. When it is time:

| Name | Where | What |
| --- | --- | --- |
| D1 `tech-demos-byok-playground` | `wrangler d1 create` then paste `database_id` into `wrangler.jsonc` | Compare budget table. Apply `migrations/0001_init.sql`. |
| `TURNSTILE_SITE_KEY` | `wrangler.jsonc` `vars` (public) | Production widget site key. Local uses the test key. |
| `TURNSTILE_SECRET` | Worker secret / `.dev.vars` | Widget secret. Never commit it. |
| `IP_HASH_SECRET` | Worker secret / `.dev.vars` | HMAC key for `ip_key`. Never commit it. |
| Rate limit namespaces | `7461` chat, `7462` models, `7463` compare | Unique in this account. Do not reuse. |
| Routes | hub path + subdomain | Same pattern as the other standalone demos. |

```bash
cd demos/byok-playground
bunx wrangler d1 create tech-demos-byok-playground
# put the database_id in wrangler.jsonc, then:
bunx wrangler secret put TURNSTILE_SECRET
bunx wrangler secret put IP_HASH_SECRET
# bun run deploy   # owner only
```

Then redeploy the hub so the gallery card is registered.

Needs Workers Paid (Workers AI, D1, rate limiting, Turnstile). No Durable Objects, R2, Queues, Containers, or Workers for Platforms.
