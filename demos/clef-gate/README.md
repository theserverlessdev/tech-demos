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

Live at [https://tech-demos.theserverless.dev/demos/clef-gate/](https://tech-demos.theserverless.dev/demos/clef-gate/). The subdomain [https://clef-gate.tech-demos.theserverless.dev/](https://clef-gate.tech-demos.theserverless.dev/) serves the same Worker.

D1 `tech-demos-clef-gate` (`3f215e72-2edb-451b-98e4-ef81a8feef39`) is bound, and migration `0001` is applied remotely. `TURNSTILE_SITE_KEY` is the production widget. `TURNSTILE_SECRET` is a Worker secret and is not in git.

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

`scripts/capture.ts` records a Playwright pass of the prefix URL into `artifacts/` (needs Chrome and `ffmpeg`).

`.dev.vars.example` has Cloudflare’s published always-pass Turnstile test secret. The Worker uses that test secret when `TURNSTILE_SECRET` is empty **and** the host is localhost. A public host with a missing secret, or with the test secret, returns `503 turnstile_unconfigured` and does not call the model.

On localhost, if Workers AI cannot be reached, the gate uses a labeled local heuristic (`source: "local-heuristic"`) so the desk still runs. Production does not. A failed Clef call there is `source: "unavailable"` and the tool does not run.

Smoke sends `x-planner: local` and `x-clef-source: heuristic`. Those headers are ignored when the host is not localhost. Against a remote URL the real Turnstile secret rejects the dummy token, and the session checks are skipped instead of throwing.

## Deploy

The Worker is already deployed. D1 and the Turnstile site key in `wrangler.jsonc` match that deploy. `TURNSTILE_SECRET` is already on the Worker.

Chat and session rate limits use namespaces `7372` and `7373`. `7371` belongs to the goodvibes demo, and `7341`–`7344` are shared by feedlog and other open branches. Those two ids take effect the next time this config is deployed. Do not recreate the database.

```bash
cd demos/clef-gate
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

Sessions last 6 hours (`SESSION_TTL_SECONDS`). An hourly cron and the Durable Object alarm delete the session row and its audit rows. Args summaries are capped; email bodies are not written to D1.
