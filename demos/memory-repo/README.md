# Memory repo

Live at [tech-demos.theserverless.dev/demos/memory-repo](https://tech-demos.theserverless.dev/demos/memory-repo/) after deploy.

An agent's long-term memory is plain markdown in a git repo. Every fact is a commit. A dream merges, dedupes, and rewrites those files, and the diff shows what changed.

Inspired by [supermemoryai/memoryrepo](https://github.com/supermemoryai/memoryrepo) (MIT, live at [memoryrepo.dev](https://memoryrepo.dev)). That project is an open-source take on Cognition's [agent memory repo](https://cognition.com/agent-memory-repo). This demo is a small slice: no Alchemy, no email, no vendored code.

## What this demonstrates

**Pattern.** One ChatAgent Durable Object per thread recalls an FTS5 index, then Workers AI replies. One MemoryAgent per anonymous visitor owns an Artifacts git repo of markdown (`MEMORY.md` plus `people.md`, `preferences.md`, and `projects.md`). Every memory write is a commit through Git smart HTTP. A 4-hour alarm, or Dream now, asks Workers AI to consolidate the files. If that output is unusable, nothing is committed and the page says why. A cron deletes the repo and the D1 row 24 hours after the last message.

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

- Four files, 12,000 characters each, messages of 800 characters, and 6 dreams per hour (the 7432 binding also caps bursts).
- Turnstile is required before the repo is created. A missing secret fails closed. Chat and dream use the visitor cookie plus rate limits.
- Workers AI writes the reply and the dream. A failed dream commits nothing. If chat's model output is unusable, obvious facts from the message can still be committed and the reply says it is a fallback.
- This browser's Artifacts repo, FTS index, chat, and D1 row are deleted 24 hours after the last message.

## What is real

- Artifacts namespace `tech-demos` (shared with repo-per-agent). The binding creates the repo, reads the tree and the log, and mints a short-lived write token. The commit itself is a Git smart HTTP push.
- D1 stores the visitor row the cron sweeps. The MemoryAgent SQLite database holds the FTS5 index, summaries, and the dream log.
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

## Deploy

Do not deploy from this PR until the resources below exist. From this folder, with the owner account (unset any other API token):

```bash
bunx wrangler d1 create tech-demos-memory-repo
# paste the database_id over the placeholder in wrangler.jsonc
bunx wrangler secret put TURNSTILE_SECRET
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

### Resources to create

| Resource | Name | Status |
| --- | --- | --- |
| D1 database | `tech-demos-memory-repo` | **Create.** `database_id` in `wrangler.jsonc` is the placeholder `00000000-0000-4000-8000-000000007431`. Replace it with the id from `wrangler d1 create`. |
| Turnstile widget | `tech-demos-memory-repo` | **Create.** Hostnames: `tech-demos.theserverless.dev`, `memory-repo.tech-demos.theserverless.dev`. Put the site key in `TURNSTILE_SITE_KEY` (it is `REPLACE_ME` today). Put the secret with `wrangler secret put TURNSTILE_SECRET`. |
| Artifacts namespace | `tech-demos` | Shared with repo-per-agent. Create it only if this account does not already have it. |
| Rate-limit namespaces | `7431` chat, `7432` dream, `7433` create, `7434` read | Created when this Worker is deployed. They do not overlap the ids already in the repo. |
| Durable Object classes | `ChatAgent`, `MemoryAgent` | Created by the `v1` migration on deploy. |
| Routes | `tech-demos.theserverless.dev/demos/memory-repo*` and `memory-repo.tech-demos.theserverless.dev/*` | Applied on deploy. The zone is `theserverless.dev`. |

Production fails closed when `TURNSTILE_SECRET` is missing, and it rejects the always-pass test secret unless `ENVIRONMENT` is `local`.

After the Worker is deployed, redeploy `apps/hub` so the gallery card is not only the fallback redirect.

## Layout

```
src/worker/   ChatAgent, MemoryAgent, git push, D1, Turnstile
src/client/   chat, memory tree, commit diff
public/       Graphite & Ember page
migrations/   visitors
test/         memory writes, dream parsing, FTS recall
```
