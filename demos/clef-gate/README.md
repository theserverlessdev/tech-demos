# Clef Gate

A desk where every sandboxed tool call stops at [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) or [Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) before it runs. The decision model returns **allow**, **deny**, or **ask-human** with probabilities. Ask-human, and any answer under the confidence floor except a leading deny, pauses inside an Agents SDK Durable Object until you approve or deny it. Each verdict is written to D1.

This is a small slice inspired by [yologdev/yoagent `clef-worker`](https://github.com/yologdev/yoagent/tree/main/integrations/yoagent-workers/examples/clef-worker) by **yologdev** (MIT). The note that pointed at it: [michellechen on X](https://x.com/michellechen/status/2106894709696422189).

- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

The five tools are fake. `read_docs` quotes demo copy. `fetch_url` describes a URL and does not request it. `send_email`, `delete_record`, and `run_sql` report what they would have done. Nothing is sent, deleted, or executed.

## What this demonstrates

**Pattern.** Every tool call is a choice from Clef or Clef-flash: allow, deny, or ask-human, with probabilities. Ask-human and any answer under the confidence floor wait in the session Durable Object until you approve or deny. Each verdict is written to D1.

**What you can do**

- Ask the desk to use one of the five sandboxed tools.
- Read the verdict and the probabilities.
- Approve or deny a paused call. It resumes in the same Durable Object.
- Open the audit list for the tool, the arguments, the decision, and your answer.
- See that send, delete, and SQL tools only describe what they would have done.

**What you could build**

- A tool-using agent with a human approval queue.
- An audit log of model verdicts before a real side effect exists.
- A gate you can later put in front of mail, SQL, or deletes.

**Limits**

- Nothing is sent, fetched, deleted, or executed. `fetch_url` does not request the URL.
- Local mode is `LOCAL_DEV=1` in `.dev.vars` only. Production has `LOCAL_DEV=0`, so the labeled heuristic, the test Turnstile secret, and `http://localhost` origins are unreachable there. A failed Clef call in production does not run the tool.
- A weak **deny** stays deny. Only a weak allow or ask-human waits for a person.
- The planner uses `@cf/zai-org/glm-5.3-flash` with `reasoning_effort: "low"` when it is reachable. An empty or failed model reply falls back to keyword rules that do not invent a delete id, a fetch URL, or a SQL statement. The gate card shows which planner ran.
- The 8s planner / Clef timeout does not cancel `AI.run`, so a timed-out call can still be billed. Cost stays small.
- Sessions last 6 hours. Args summaries are capped. Email bodies are not written to D1.
- Session cookies are `id.exp.hmac`. A forged or expired cookie never wakes a Durable Object. Ended sessions call `destroy()` so SQLite storage is freed.

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Agents SDK** | One Durable Object per anonymous session. The pending tool call sits in SQLite until Approve, Deny, or the 10-minute `schedule()`. Expiry and forget call `destroy()`. |
| **Workers AI** | `toolGate()` asks `@cf/cloudflare/clef` or `@cf/cloudflare/clef-flash` one System One choice question. The planner uses `@cf/zai-org/glm-5.3-flash` when it is reachable, and keyword rules otherwise. |
| **D1** | Audit row per decision: tool, args summary, decision, probabilities, latency, model, human outcome. A live D1 row is required before `idFromName`. |
| **Rate Limiting** | 12 chat/approval writes per minute per IP, 6 new sessions per minute, 60 session/audit reads per minute. |
| **Turnstile** | Required on chat, session start, and approval. |

`toolGate()` lives in `src/worker/tool-gate.ts` with its types. It does not execute tools. That is the shape a shared guardrails package (repo issue #95) can re-export later.

## How it works

```text
browser ── Turnstile + chat ──► Worker (rate limit, signed cookie)
                                  └─ GateAgent Durable Object
                                       ├─ planner (Workers AI, or local rules)
                                       ├─ toolGate() ──► Clef / Clef-flash
                                       ├─ allow ──► sandboxed fake tool
                                       ├─ ask-human ──► pending row, HTTP returns
                                       └─ every verdict ──► D1
browser ── Approve / Deny ──► same DO resumes the call
```

Live at [https://tech-demos.theserverless.dev/demos/clef-gate/](https://tech-demos.theserverless.dev/demos/clef-gate/). The subdomain [https://clef-gate.tech-demos.theserverless.dev/](https://clef-gate.tech-demos.theserverless.dev/) serves the same Worker.

D1 `tech-demos-clef-gate` (`3f215e72-2edb-451b-98e4-ef81a8feef39`) is bound, and migration `0001` is applied remotely. `TURNSTILE_SITE_KEY` is the production widget. `TURNSTILE_SECRET` and `SESSION_KEY` are Worker secrets and are not in git.

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing. Asset URLs are relative, so the same build works at the prefix and at the subdomain root.

## Local

```bash
cd demos/clef-gate
bun install
cp .dev.vars.example .dev.vars
bun run dev
```

`.dev.vars.example` sets `LOCAL_DEV=1`, the always-pass Turnstile test site key and secret, and a local `SESSION_KEY`. The test-widget note then appears on the page, and Send enables. `bun run dev` uses the remote, billed Workers AI binding and needs `wrangler login`, unless you send the smoke headers (`x-planner: local` and `x-clef-source: heuristic`).

Then, in another shell:

```bash
bun run scripts/smoke.ts http://127.0.0.1:8787
```

`scripts/capture.ts` records a Playwright pass of the prefix URL into `artifacts/` (needs Chrome via Playwright's `channel: "chrome"` and `ffmpeg`).

A public host with a missing secret, or with the test secret, returns `503 turnstile_unconfigured` and does not call the model. The same is true for a missing `SESSION_KEY` (`503 session_unconfigured`).

Smoke sends `x-planner: local` and `x-clef-source: heuristic`. Those headers are ignored unless `LOCAL_DEV=1`. Against a remote URL the real Turnstile secret rejects the dummy token, and the session checks are skipped instead of throwing.

## Deploy

Use the package script so the client bundle is built before upload. A bare `wrangler deploy` would ship `index.html` without `public/assets/app.js` (that file is gitignored).

```bash
cd demos/clef-gate
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID bun run deploy
```

Owner must already have, or create once:

- Worker secret `TURNSTILE_SECRET` (already on the live Worker).
- Worker secret `SESSION_KEY` (`wrangler secret put SESSION_KEY`). Without it, session create returns `503 session_unconfigured`.
- Rate-limit namespaces `7372` (chat), `7373` (session create), and **`7467`** (reads, 60/60s). `7467` is new; 7451–7466 are taken. Wrangler creates the namespace from this config on the next deploy. Do not recreate the D1 database.

Sessions last 6 hours (`SESSION_TTL_SECONDS`). Cookie `Max-Age` matches that value. An hourly cron and the Durable Object `schedule()` delete the session row, its audit rows, and the DO storage. Args summaries are capped; email bodies are not written to D1.
