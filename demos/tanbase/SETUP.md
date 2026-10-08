# Setup — tanbase

Live at <https://tech-demos.theserverless.dev/demos/tanbase/>.

The D1 database `tech-demos-tanbase` (`67b63062-595d-48dc-a13c-2585dbeb5612`), the R2 bucket `tech-demos-tanbase`, and the Workflow `tech-demos-tanbase-split` are created. `TURNSTILE_SITE_KEY` in `wrangler.jsonc` is the live widget key. `TURNSTILE_SECRET` is a Worker secret (`wrangler secret put`), not a var — a var with that name would collide with the secret and fail Workers Builds. Rate-limit namespaces are `7391` (writes), `7392` (uploads), and `7393` (AI). `7394` is reserved and unused.

## Local

```bash
cd demos/tanbase
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

`.dev.vars.example` contains the published always-pass test secret and the matching test site key:

```text
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
TURNSTILE_SITE_KEY=1x00000000000000000000AA
```

Those override the live site key for `wrangler dev` only. They are dummy credentials from Cloudflare's Turnstile testing docs.

`bun run typecheck` runs `wrangler types` before `tsc`, so a clean clone does not need a committed `worker-configuration.d.ts`.

## Routes

- `tech-demos.theserverless.dev/demos/tanbase*`
- `tanbase.tech-demos.theserverless.dev/*`

## What stays stubbed

- Reminder delivery is a D1 log line. Nothing is emailed.
- If Workers AI returns something other than 3–6 JSON subtasks, the workflow writes four fixed fallback subtasks and says so in the drawer.
