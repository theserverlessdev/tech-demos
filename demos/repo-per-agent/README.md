# Repo per agent

Live at [tech-demos.theserverless.dev/demos/repo-per-agent](https://tech-demos.theserverless.dev/demos/repo-per-agent/).

One [Agents SDK](https://developers.cloudflare.com/agents/) agent and one [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) git repository per task. Workers AI edits a three-file tree. The page shows the commit log, a unified diff, and a ten-minute read-only `git clone` token.

Inspired by [choyiny/gitorange](https://github.com/choyiny/gitorange) (Apache-2.0, by choyiny). The note that pointed at Artifacts: [x.com/haipingfu/status/2107011097039605909](https://x.com/haipingfu/status/2107011097039605909).

## What is real

- Artifacts namespace `tech-demos` on the Workers Paid account. Creating a repo, pushing a commit, and reading it back was verified before this demo was written.
- The agent commits through Git smart HTTP (`git-receive-pack`). The Artifacts binding creates repos, reads trees, and mints tokens. It does not write file bytes.
- D1 stores the task and the activity rows. A cron deletes expired repos and those rows.
- Turnstile is checked on create and run. Rate limits cover create (7381), run (7382), token mint (7383), and reads (7384). A browser cookie can hold 3 live repos.

Workers AI authors the commit. If the model fails or returns the same file, nothing is committed.

## Run locally

```bash
cd demos/repo-per-agent
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

`.dev.vars` uses Cloudflare's always-pass Turnstile test keys. `bun run smoke` expects the dev server on `http://127.0.0.1:8787`.

The Artifacts binding is `remote: true`, so local dev talks to the real namespace. `wrangler dev` still needs a logged-in Wrangler session for that.

## Deploy

```bash
cd demos/repo-per-agent
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

Resources already created on the account:

| Resource | Name |
| --- | --- |
| Worker | `tech-demos-repo-per-agent` |
| D1 | `tech-demos-repo-per-agent` (`94497718-3138-4506-a005-0c91bcc80f0e`) |
| Artifacts namespace | `tech-demos` |
| Turnstile widget | `tech-demos-repo-per-agent`, site key `0x4AAAAAAFRUoj5qDpf7XyIW` |

Routes: `tech-demos.theserverless.dev/demos/repo-per-agent*` and `repo-per-agent.tech-demos.theserverless.dev/*`.

Rate-limit namespaces in this config are 7381–7384. The worker that is live still uses 7341–7343 until the next deploy of this file. `bun run typecheck` runs `wrangler types` before `tsc`, so a clean clone does not need a committed `worker-configuration.d.ts`.

Secret (do not commit it):

```bash
bunx wrangler secret put TURNSTILE_SECRET
```

The widget secret is in the Turnstile dashboard for that site key. Production fails closed when `TURNSTILE_SECRET` is missing. The public site key lives in `wrangler.jsonc`.

After the worker is deployed, redeploy `apps/hub` so the gallery card is not only a fallback redirect.

## Layout

```
src/worker/   API, TaskAgent, git push, D1, Turnstile
src/client/   commit log and diff
public/       Graphite & Ember page
migrations/   tasks + activity
```
