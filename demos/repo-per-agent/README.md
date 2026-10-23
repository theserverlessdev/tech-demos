# Repo per agent

Live at [tech-demos.theserverless.dev/demos/repo-per-agent](https://tech-demos.theserverless.dev/demos/repo-per-agent/). Canonical host: [repo-per-agent.tech-demos.theserverless.dev](https://repo-per-agent.tech-demos.theserverless.dev/).

One [Agents SDK](https://developers.cloudflare.com/agents/) agent and one [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) git repository per task. Workers AI edits a three-file tree. The page shows the commit log, a line diff, and a ten-minute read-only `git clone` token.

Inspired by [choyiny/gitorange](https://github.com/choyiny/gitorange) (Apache-2.0, by choyiny). The note that pointed at Artifacts: [x.com/haipingfu/status/2107011097039605909](https://x.com/haipingfu/status/2107011097039605909).

## What this demonstrates

**Pattern.** One Agents SDK agent and one Cloudflare Artifacts git repository per task. The agent commits a small file edit through Git smart HTTP. The Artifacts binding creates the repo, reads the tree, and mints a ten-minute read-only clone token. If the model returns the same file, nothing is committed. The agent serializes runs for its repo.

**What you can do**

- Create a task after Turnstile and get a fresh Artifacts repo.
- Run the agent and, when the model changes a file, see the commit.
- Read the commit log and the line diff.
- Mint a ten-minute read-only `git clone` token.
- Watch an unchanged model response commit nothing.

**What you could build**

- A coding agent with one repo per ticket.
- A review page that shows the diff before anyone clones.
- A scratch repo that a cron deletes with its log rows and Durable Object.

**Limits**

- The Artifacts binding does not write file bytes. The commit goes through Git smart HTTP (`git-receive-pack`).
- A browser cookie can hold 3 live repos. There is also a global ceiling of 300 live repos. D1 stores the task and the activity rows.
- Workers AI authors the commit (`@cf/zai-org/glm-5.3-flash`, `reasoning_effort: low`, `max_completion_tokens: 4096`, JSON schema). A failed or unchanged model response is not committed. Shared daily cap: 80 runs.
- Turnstile is required on create and run. Production fails closed when the secret is missing.
- The hub path shares an origin with every other demo. Prefer the subdomain if you care about cookie isolation.

## What is real

- Artifacts namespace `tech-demos` on the Workers Paid account. Creating a repo, pushing a commit, and reading it back was verified before this demo was written.
- The agent commits through Git smart HTTP (`git-receive-pack`). The Artifacts binding creates repos, reads trees and blobs, and mints tokens. It does not write file bytes.
- D1 stores the task and the activity rows. A cron deletes expired repos, those rows, and the TaskAgent Durable Object.
- Turnstile is checked on create and run. Rate limits cover create (7381), run (7382), token mint (7383), and reads including `/api/health` (7384). No new rate-limit ids.

Workers AI authors the commit. If the model fails, runs out of tokens, or returns the same file, nothing is committed.

This PR proves the create → run → commit → line-diff path with a local fake Artifacts store and a scripted model reply (`bun test` / `bun run preview`). It does not spend a live GLM call. After deploy, one create → run on the live worker is the paid proof.

## Run locally (free)

```bash
cd demos/repo-per-agent
cp .dev.vars.example .dev.vars
bun install
bun run preview
```

That serves the real UI on `http://127.0.0.1:8787` with an in-process Artifacts fake (real `git receive-pack`) and a scripted Workers AI reply. No `tech-demos` repo is created. No GLM call is made.

```bash
bun test
bun run smoke
```

`bun run smoke` against the preview creates one fake repo, runs the scripted model, checks the line diff, then `POST /api/dev/purge` deletes it. `/api/dev/purge` exists only when `ENVIRONMENT=local` or `DIRECT_RUN=1`.

## Run against the remote binding (paid)

`wrangler.jsonc` still points at namespace `tech-demos` with `remote: true`. `bun run dev` therefore talks to the real shared namespace and Workers AI. That creates one real repo per create and one GLM call per run (about $0.002). Local D1 cannot see those rows from production cron, so leftover repos pile up unless you purge.

`.dev.vars` sets `ENVIRONMENT=local`, which enables `POST /api/dev/purge` so `bun run smoke` can delete the repo it created. Do not set `ENVIRONMENT=local` in production.

This repo does not create a `tech-demos-dev` namespace. That would be a Cloudflare API change. If you want isolated remotes later, create that namespace in the dashboard and point an env at it.

## Deploy

Do not deploy from this agent. Owner steps are in the pull request.

```bash
cd demos/repo-per-agent
bunx wrangler d1 migrations apply DB --remote
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

Resources already created on the account:

| Resource | Name |
| --- | --- |
| Worker | `tech-demos-repo-per-agent` |
| D1 | `tech-demos-repo-per-agent` (`94497718-3138-4506-a005-0c91bcc80f0e`) |
| Artifacts namespace | `tech-demos` |
| Turnstile widget | shared `tech-demos-shared` (was `tech-demos-repo-per-agent`), site key `0x4AAAAAAFRUoj5qDpf7XyIW` |

Routes after the next deploy: `tech-demos.theserverless.dev/demos/repo-per-agent`, `tech-demos.theserverless.dev/demos/repo-per-agent/*`, and `repo-per-agent.tech-demos.theserverless.dev/*`.

Rate-limit namespaces in this config are 7381–7384. Confirm them in the dashboard after deploy. `bun run typecheck` runs `wrangler types` before `tsc`, so a clean clone does not need a committed `worker-configuration.d.ts`.

Secret (do not commit it):

```bash
bunx wrangler secret put TURNSTILE_SECRET
```

The widget secret is in the Turnstile dashboard for that site key. Production fails closed when `TURNSTILE_SECRET` is missing. The public site key lives in `wrangler.jsonc`.

Apply every pending D1 migration (`0002_caps.sql`, `0003_next_attempt.sql`) **before** deploying the worker. Deploying first breaks create (missing `attempts`) and run (missing `ai_daily`) until the new columns land. The commands above already apply migrations first. Then redeploy `apps/hub` so the gallery card is not only a fallback redirect.

## Layout

```
src/worker/   API, TaskAgent, git push, D1, Turnstile
src/client/   commit log and line diff
public/       Graphite & Ember page
migrations/   tasks + activity + daily AI counter + cleanup retry column
test/         create → run → diff proof (fake Artifacts + scripted model)
```
