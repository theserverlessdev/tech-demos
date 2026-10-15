# Setup — tanbase

Live at <https://tech-demos.theserverless.dev/demos/tanbase/>.

The D1 database `tech-demos-tanbase` (`67b63062-595d-48dc-a13c-2585dbeb5612`), the R2 bucket `tech-demos-tanbase`, and the Workflow `tech-demos-tanbase-split` are created. `TURNSTILE_SITE_KEY` in `wrangler.jsonc` is the live widget key. `TURNSTILE_SECRET` is a Worker secret (`wrangler secret put`), not a var — a var with that name would collide with the secret and fail Workers Builds. Rate-limit namespaces are declared in `wrangler.jsonc` as `7540` (writes), `7541` (uploads), and `7542` (AI). `7543`–`7549` stay unused in production. There is no dashboard step; this PR does not call the Cloudflare API. `wrangler.local.jsonc` uses worker name `tech-demos-tanbase-local`, Workflow `tech-demos-tanbase-split-local`, and rate-limit ids `7543`–`7545` so a mistaken local deploy cannot replace production bindings.

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

- `tech-demos.theserverless.dev/demos/tanbase` and `…/demos/tanbase/*`
- `tanbase.tech-demos.theserverless.dev/*`

## Owner steps

This PR does not deploy and does not call the Cloudflare API.

1. Rate-limit ids `7540` (writes), `7541` (uploads), and `7542` (AI) are already in `wrangler.jsonc`. Production leaves `7543`–`7549` unused. Local `wrangler.local.jsonc` uses `7543`–`7545`. No dashboard change is required.
2. Deploy `demos/tanbase` when you want the audit fixes live (`bun run deploy` from that folder). Routes are `…/demos/tanbase` and `…/demos/tanbase/*`.
3. After deploy, complete one live split and check the drawer: it should say “Subtasks came from Workers AI” if `@cf/zai-org/glm-5.3-flash` returned JSON. If it still falls back, keep the honest copy and re-shoot `artifacts/split.png` only after a real AI write.
4. `TURNSTILE_SECRET` is already a Worker secret. Do not put it in `wrangler.jsonc`.

## What stays stubbed

- Reminder delivery is a D1 log line. Nothing is emailed.
- If Workers AI returns something other than 3–6 JSON subtasks, the AI step picks four fixed fallback subtasks and the write step stores them. The drawer says which source wrote them. A live paid Workers AI call was not made here.
