# Memory repo

Live at [tech-demos.theserverless.dev/demos/memory-repo](https://tech-demos.theserverless.dev/demos/memory-repo/). Self-hosters: deploy with the steps below.

An agent's long-term memory is plain markdown in a git repo. Every fact is a commit. A dream merges, dedupes, and rewrites those files, and the diff shows what changed.

Inspired by [supermemoryai/memoryrepo](https://github.com/supermemoryai/memoryrepo) (MIT, live at [memoryrepo.dev](https://memoryrepo.dev)). That project is an open-source take on Cognition's [agent memory repo](https://cognition.com/agent-memory-repo). This demo is a small slice: no Alchemy, no email, no vendored code.

## What this demonstrates

**Pattern.** One ChatAgent Durable Object per thread recalls an FTS5 index, then Workers AI replies. One MemoryAgent per anonymous visitor owns an Artifacts git repo of markdown (`MEMORY.md` plus `people.md`, `preferences.md`, and `projects.md`). Every memory write is a commit through Git smart HTTP. A 4-hour alarm, or Dream now, asks Workers AI to consolidate the files. If that output is unusable, nothing is committed and the page says why. A cron and a Durable Object alarm delete the repo, the chat Durable Object, and the D1 row 24 hours after the last message.

**What you can do**

- Pass Turnstile and open a memory repo for this browser.
- State a name, preference, or project and see the commit.
- Read `MEMORY.md` and the topic files the reply recalled.
- Open a commit and read the unified diff.
- Run Dream now and see the steps, or why nothing was committed.

**What you could build**

- A personal agent whose memory you can clone and audit.
- A consolidation job that rewrites notes and leaves a diff.
- A demo tenant whose git repo deletes itself on a timer.

**Limits**

- Four files, 12,000 characters each, 40 bullets per topic file (the oldest is evicted), messages of 800 characters, and 6 dreams per hour (the 7432 binding also caps bursts).
- Turnstile is required before the repo is created. A missing secret fails closed. Chat and dream use the visitor cookie plus rate limits.
- One browser gets 40 Workers AI turns per UTC day, so two visitors cannot spend the whole demo budget. The Worker as a whole stops at 300 AI calls per UTC day. If D1 migration `0002` (`ai_meter`) is missing, chat and dream return a clear 503 instead of a 502.
- Workers AI writes the reply and the dream. A failed dream commits nothing. If chat's model output is unusable, obvious facts from the message can still be committed and the reply says it is a fallback. Questions are not treated as facts.
- A dream asks for only the files that changed, with `max_tokens` 6000, which is enough for four topic files at the 40-bullet cap. Unusable JSON commits nothing.
- This browser's Artifacts repo, FTS index, chat Durable Object, and D1 row are deleted 24 hours after the last message.

## What is real

- Artifacts namespace `tech-demos` (shared with repo-per-agent). The binding creates the repo, reads the tree and the log, and mints a short-lived write token. The commit itself is a Git smart HTTP push.
- D1 stores the visitor row the cron sweeps and the global `ai_meter` row. The MemoryAgent SQLite database holds the FTS5 index, summaries, the dream log, and the per-visitor daily AI counter.
- The dream alarm is Agents SDK `schedule()` (it owns the Durable Object alarm). A 15-minute cron is the backstop that deletes expired repos.

## Run locally

```bash
cd demos/memory-repo
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

`.dev.vars` uses Cloudflare's [always-pass Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/). `ENVIRONMENT=local` is required because `wrangler dev` rewrites Host to the first production route. The widget token for those keys is `XXXX.DUMMY.TOKEN.XXXX`.

The Artifacts binding in `wrangler.jsonc` is `remote: true`, and Workers AI is remote too. `bun run dev` needs a logged-in Wrangler session. Without that login, Wrangler stops to open an OAuth browser.

`bun run dev:local` uses `wrangler.local.jsonc`, which omits Artifacts and Workers AI. Because `ENVIRONMENT=local`, the MemoryAgent then stores the same git commit objects in its SQLite database and the page says so. Production `ENVIRONMENT` is empty, so a missing Artifacts binding is an error and nothing is mirrored. A dream with no Workers AI commits nothing and shows why. `bun run test` covers memory writes, dream parsing, and FTS recall either way.

`bun run typecheck` runs `wrangler types` before `tsc`, so a clean clone does not need a committed `worker-configuration.d.ts`.

## Deploy (self-hosters)

This demo is already live on the tech-demos account. To run your own copy, from this folder, with that account (unset any other API token):

```bash
bunx wrangler d1 create tech-demos-memory-repo
# paste the database_id over the placeholder in wrangler.jsonc
bunx wrangler secret put TURNSTILE_SECRET
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

A brand-new Worker with `secrets.required` needs a first deploy before `wrangler secret put` works, or a secrets file.

### Resources to create

| Resource | Name | Status |
| --- | --- | --- |
| D1 database | `tech-demos-memory-repo` | **Exists.** `database_id` in `wrangler.jsonc` is `a4810d2e-56d9-424f-a9f8-93cdbb41a42c`. Self-hosters: `wrangler d1 create tech-demos-memory-repo` and paste that id over the one in `wrangler.jsonc`. |
| Turnstile widget | shared `tech-demos-shared` | **Reuse it.** Do not create a widget. Site key `0x4AAAAAAFRUoj5qDpf7XyIW` is in `wrangler.jsonc`. Secret: `wrangler secret put TURNSTILE_SECRET`. See `docs/turnstile.md`. |
| Artifacts namespace | `tech-demos` | Shared with repo-per-agent. Create it only if this account does not already have it. |
| Rate-limit namespaces | `7431` chat, `7432` dream, `7433` create, `7434` read | Created when this Worker is deployed. They do not overlap the ids already in the repo. New ids must be 7490+. |
| Durable Object classes | `ChatAgent`, `MemoryAgent` | Created by the `v1` migration on deploy. |
| Routes | `tech-demos.theserverless.dev/demos/memory-repo`, `/demos/memory-repo/*`, and `memory-repo.tech-demos.theserverless.dev/*` | Applied on deploy. The zone is `theserverless.dev`. `workers_dev` is off. |

Production fails closed when `TURNSTILE_SECRET` is missing, and it rejects the always-pass test secret unless `ENVIRONMENT` is `local`.

After the Worker is deployed, redeploy `apps/hub` so the gallery card is not only the fallback redirect.

## Layout

```
src/worker/   ChatAgent, MemoryAgent, git push, D1, Turnstile
src/client/   chat, memory tree, commit diff
public/       Graphite & Ember page
migrations/   visitors, ai_meter
test/         memory writes, dream parsing, FTS recall
```
