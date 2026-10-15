# Plan — repo-per-agent (audit fixes)

## Goal

Make the demo merge-ready against the 2026-10-15 audit: prove the Workers AI commit path, fit the task view on a 390px phone, and close the should-fix cost and availability gaps. No new GitHub repo, no deploy, no Cloudflare API changes.

## MVP for this pass

- In:
  - GLM-5.3-flash call matches current docs: `reasoning_effort: "low"`, `max_tokens: 4096`, `response_format` json_schema. Token exhaustion is reported as such.
  - A local test/smoke that runs create → run → commit → line diff with a fake Artifacts store and a scripted model reply. That is the proof in this PR. A live GLM call stays an owner step.
  - Task view uses `minmax(0, 1fr)` so a 390px phone does not grow a horizontal scrollbar.
  - Turnstile waits for `api.js` onload and removes the run widget before remount.
  - `/api/health` is rate-limited and checks D1 only.
  - Commit views are cached; blobs are read by hash; the task commit list comes from D1 activity.
  - Create no longer wakes a Durable Object. Cron destroys expired agents, loops until empty or ~20s, and backs off failed deletes.
  - Repo cap is an atomic insert plus a global live ceiling. Smoke deletes the repo it created. Copy is honest about paid calls.
  - Graphite & Ember only. Rate-limit bindings stay 7381–7384; no new ids.
- Out: deploy, a new Artifacts namespace, Cloudflare dashboard/API writes, a paid GLM call from this agent.

## Tasks

1. Model request + token-exhaustion errors + unit tests.
2. Local fake Artifacts (real receive-pack) + scripted AI + create → run → diff smoke.
3. 390px layout, Turnstile onload, client error handling, tap targets.
4. Health, commit cache, atomic cap, cron, DO purge, daily AI counter.
5. README / CHANGELOG / hub registry copy. 390px screenshot and video of the local flow.

## Stack

Unchanged: Workers Paid, Agents SDK DO, Artifacts `tech-demos`, D1, Turnstile, Graphite & Ember. Local proof uses Bun + in-process fakes so `bun test` does not touch the shared namespace or Workers AI.

## Deferred

- Owner deploy, then one live create → run → diff against GLM-5.3-flash.
- Optional `tech-demos-dev` namespace (Cloudflare API; not created here).
- Hub-wide same-origin cookie risk (N17): documented, not unique to this demo.
