# Clef Gate

A desk where every sandboxed tool call stops at [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) or [Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) before it runs. The decision model returns **allow**, **deny**, or **ask-human** with probabilities. Ask-human, and any answer under the confidence floor, pauses inside an Agents SDK Durable Object until you approve or deny it. Each verdict is written to D1.

This is a small slice inspired by [yologdev/yoagent `clef-worker`](https://github.com/yologdev/yoagent/tree/main/integrations/yoagent-workers/examples/clef-worker) by **yologdev** (MIT). The note that pointed at it: [michellechen on X](https://x.com/michellechen/status/2106894709696422189).

- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

The five tools are fake. `read_docs` quotes demo copy. `fetch_url` describes a URL and does not request it. `send_email`, `delete_record`, and `run_sql` report what they would have done. Nothing is sent, deleted, or executed.

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Agents SDK** | One Durable Object per anonymous session. The pending tool call sits in SQLite until Approve, Deny, or the 10-minute alarm. |
| **Workers AI** | `toolGate()` asks `@cf/cloudflare/clef` or `@cf/cloudflare/clef-flash` one System One choice question. The planner uses `@cf/zai-org/glm-5.3-flash` when it is reachable. |
| **D1** | Audit row per decision: tool, args summary, decision, probabilities, latency, model, human outcome. |
| **Rate Limiting** | 12 chat/approval writes per minute per IP, 6 new sessions per minute. |
| **Turnstile** | Required on chat, session start, and approval. |

`toolGate()` lives in `src/worker/tool-gate.ts` with its types. It does not execute tools. That is the shape a shared guardrails package (repo issue #95) can re-export later.

## How it works

```text
browser ── Turnstile + chat ──► Worker (rate limit, cookie)
                                  └─ GateAgent Durable Object
                                       ├─ planner (Workers AI, or local rules)
                                       ├─ toolGate() ──► Clef / Clef-flash
                                       ├─ allow ──► sandboxed fake tool
                                       ├─ ask-human ──► pending row, HTTP returns
                                       └─ every verdict ──► D1
browser ── Approve / Deny ──► same DO resumes the call
```

Routes, once deployed:

- `https://tech-demos.theserverless.dev/demos/clef-gate/`
- `https://clef-gate.tech-demos.theserverless.dev/`

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing. Asset URLs are relative, so the same build works at the prefix and at the subdomain root.

## Local

```bash
cd demos/clef-gate
bun install
cp .dev.vars.example .dev.vars
bun run dev
```

Then, in another shell:

```bash
bun run scripts/smoke.ts http://127.0.0.1:8787
```

`scripts/capture.ts` records a Playwright pass of the prefix URL into `artifacts/` (needs Chrome and `ffmpeg`). Smoke and capture on this machine used the local heuristic, because `wrangler whoami` was not logged in and Workers AI did not answer.

`wrangler.jsonc` ships Cloudflare’s published always-pass Turnstile site key (`1x00000000000000000000AA`). `.dev.vars.example` has the matching test secret. The Worker also uses that test secret when `TURNSTILE_SECRET` is empty **and** the host is localhost. A public host with a missing secret, or with the test secret, returns `503 turnstile_unconfigured` and does not call the model.

On localhost, if Workers AI cannot be reached, the gate uses a labeled local heuristic (`source: "local-heuristic"`) so the desk still runs. Production does not. A failed Clef call there is `source: "unavailable"` and the tool does not run.

Smoke sends `x-planner: local` and `x-clef-source: heuristic`. Those headers are ignored when the host is not localhost.

## Deploy

Needs a D1 database, a Durable Object migration, Workers AI, the two rate-limit namespaces, and a real Turnstile widget. From this folder, with the owner account (unset any other API token):

```bash
cd demos/clef-gate
bunx wrangler whoami
bunx wrangler d1 create tech-demos-clef-gate
# Put the database_id into wrangler.jsonc (the committed id is a local placeholder).

# Create a Turnstile widget for both hostnames, then:
#   set TURNSTILE_SITE_KEY in wrangler.jsonc to the real site key
bunx wrangler secret put TURNSTILE_SECRET

env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
bunx wrangler d1 migrations apply DB --remote
```

Redeploy the hub (`apps/hub`) after this Worker so the gallery card is live. The fallback redirect only matters when the zone route is missing.

Sessions last 6 hours (`SESSION_TTL_SECONDS`). An hourly cron and the Durable Object alarm delete the session row and its audit rows. Args summaries are capped; email bodies are not written to D1.

## Owner steps if this environment could not deploy

1. `bunx wrangler login` (or export a token), then `bunx wrangler whoami` and confirm account `3f847e2fadeef3e583701e8fa25657b5`.
2. `bunx wrangler d1 create tech-demos-clef-gate` and replace `database_id` in `wrangler.jsonc`.
3. Create a Turnstile widget for `tech-demos.theserverless.dev` and `clef-gate.tech-demos.theserverless.dev`. Put the site key in `TURNSTILE_SITE_KEY`. `bunx wrangler secret put TURNSTILE_SECRET`.
4. Deploy with the command above, then `bunx wrangler d1 migrations apply DB --remote`.
5. Redeploy `apps/hub`.
6. Open `https://clef-gate.tech-demos.theserverless.dev/` and run one prompt without the heuristic headers so the audit row’s `source` is `clef` or `clef-flash`.
