# BYOK playground

A bring-your-own-key AI playground. Paste an OpenAI-compatible API key, base URL, and model id. The Worker proxies `/chat/completions` and `/models` without storing the key.

- **Live (after deploy):** <https://byok-playground.tech-demos.theserverless.dev/>
- **Hub path:** <https://tech-demos.theserverless.dev/demos/byok-playground/> 308s to the subdomain so key storage is origin-isolated from the other demos.
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What this demonstrates

**Pattern.** This Worker is not a general-purpose proxy: only `/models` and `/chat/completions`, https on port 443, no redirects, rate-limited. The key lives in the browser (`sessionStorage` by default, opt-in Remember on `localStorage`). Each request sends it in the JSON body. The Worker does not store it. Invocation logs are disabled; until a live dashboard check confirms headers and bodies are not captured, this README does not claim the key is never logged. SSRF is blocked on a best-effort basis (DNS plus platform egress; DNS rebinding remains a residual risk), redirects are refused, and Workers AI comparison is Turnstile-gated with an atomic D1 daily budget.

**What you can do**

- Paste a key, an https base URL, and a model id, then stream a chat. Multi-turn sends the transcript (at most 15 turns, 4,000 bytes each — about 1,300 CJK or Devanagari characters). The composer shows a live byte count and errors instead of silently trimming.
- List models from `GET /models`. The Worker returns only `{ data: [{ id }] }`.
- Send the same prompt to your model and to Workers AI. Read latency, time to first token, and tokens where the endpoint reports them. Each compare spends one of today’s shared runs.
- Probe streaming, tools / function calling, JSON schema `response_format`, and vision. Tools pass only with `tool_calls`; JSON schema pass only with the required keys and a nonce; vision must name the left pixel of a two-pixel image. A missing model is reported once. Otherwise the result is fail, unsupported, or inconclusive.

**What you could build**

- A product that accepts a customer’s OpenAI-compatible key without writing it to disk.
- A migration bench that compares a provider against Workers AI on the same prompt.
- An eval harness that records which capabilities an endpoint actually implements.

**Limits**

- Only `/chat/completions` and `/models` under the pasted base. https on port 443 (`http://localhost` only when `ENVIRONMENT=local`).
- No redirects. Hop-by-hop headers and cookies are stripped. Visitor cookies are never forwarded.
- DNS to the visitor URL is best-effort against rebinding. `global_fetch_strictly_public` (platform egress) is the backstop.
- Compare spends the shared Workers AI budget and requires Turnstile action `compare`. Chat is not stored; D1 holds only the compare budget. Off localhost, `TURNSTILE_SITE_KEY=REPLACE_ME` (or a missing widget secret) fails closed: session mint returns 503 and the proxy stays off until a real site key and secret are set.
- Streams are rate-limited per network (`IPv4 /32`, `IPv6 /64`). There is no per-isolate concurrency lock. One network can hold about 40 concurrent 120 s streams (20 requests/min × 2 min overall cap); that is cheap on Workers, and the per-network rate limit is the control.
- Local `bun run dev` omits the Workers AI binding and uses a labelled stub.

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Workers + Static Assets** | Serves the playground and the proxy API from one Worker on the demo subdomain. |
| **SSRF guard** | Blocks private, loopback, link-local, CGNAT, metadata, internal hostnames (including `.svc`, `.home.arpa`, `theserverless.dev`, `*.workers.dev`), and IP literals. DNS is best-effort; egress is the backstop. |
| **Rate limiting** | Chat `7461`, models `7462`, compare `7463`, session mint `7464`, keyed by network (`IPv4 /32`, `IPv6 /64`). |
| **Turnstile** | One pass mints an HMAC-signed session cookie (issued-at + network key, 12h, rejected on network change). Re-mints after a network change or the 12 h expiry use a dedicated session-action widget, then remount compare. Compare requires action `compare`. Off localhost, missing site key or secret fails closed (503, proxy off). The test secret also requires a localhost request. `http://localhost` is allowed only when `ENVIRONMENT=local` **and** the request is local. |
| **D1** | Atomic daily compare budget. Rows store an HMAC’d `ip_key`, never the address. |
| **Workers AI** | The “ours” side of compare. Local wrangler config stubs it. |

## How it works

```text
browser (sessionStorage) ── JSON body.apiKey ──► Worker
                                                 ├─ HMAC session cookie (after Turnstile)
                                                 ├─ same-origin
                                                 ├─ SSRF + path allowlist + egress flag
                                                 ├─ POST /chat/completions  (SSE passthrough)
                                                 ├─ GET  /models  → { data: [{ id }] }
                                                 └─ compare ─ Turnstile action=compare + D1 budget ─ Workers AI
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

`.dev.vars` holds Cloudflare’s published always-pass Turnstile test secret (`1x0000000000000000000000000000000AA`), a local `IP_HASH_SECRET`, and a local `SESSION_SECRET`. `wrangler.local.jsonc` sets `ENVIRONMENT=local` and the matching test site key. The test Turnstile secret and `http://localhost` are allowed only when `ENVIRONMENT=local`.

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
| `TURNSTILE_SITE_KEY` | `wrangler.jsonc` `vars` (public) | Shared widget site key (`docs/turnstile.md`). `REPLACE_ME` fails closed off localhost (proxy and compare off). Local uses the test key. |
| `TURNSTILE_SECRET` | Worker secret / `.dev.vars` | Widget secret. Never commit it. |
| `IP_HASH_SECRET` | Worker secret / `.dev.vars` | HMAC key for `ip_key`. Never commit it. |
| `SESSION_SECRET` | Worker secret / `.dev.vars` | HMAC key for the session cookie. Never commit it. |
| Rate limit namespaces | `7461` chat, `7462` models, `7463` compare, `7464` session | Unique in this account. Do not reuse. |
| Routes | hub path 308s to the subdomain | Key storage is origin-isolated. |

```bash
cd demos/byok-playground
bunx wrangler d1 create tech-demos-byok-playground
# put the database_id in wrangler.jsonc, then:
bunx wrangler secret put TURNSTILE_SECRET
bunx wrangler secret put IP_HASH_SECRET
bunx wrangler secret put SESSION_SECRET
# bun run deploy   # owner only
```

### Deploy checklist (after the owner deploys)

1. Confirm the hub path 308s to `https://byok-playground.tech-demos.theserverless.dev/`.
2. **Workers Logs:** open Observability → Logs for this Worker and confirm invocation logs are off. Send one chat request, then search logs for the pasted key and for `x-byok-key`. Until that live check is done, do not claim the key is never logged.
3. Confirm traces are off (so `url.full` cannot carry a key). Keys are in the JSON body, not the URL.
4. Confirm Turnstile uses the shared widget (`docs/turnstile.md`), not `REPLACE_ME` or the always-pass test keys.
5. Redeploy the hub so the gallery card is registered.

Needs Workers Paid (Workers AI, D1, rate limiting, Turnstile). No Durable Objects, R2, Queues, Containers, or Workers for Platforms.
