# Setup — tanbase

Production fails closed until `TURNSTILE_SECRET` is set. The site key shipped in `wrangler.jsonc` is Cloudflare's **always-pass test key**. Replace it before the public demo should reject bots.

## Local

```bash
cd demos/tanbase
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

`.dev.vars.example` contains the published always-pass test secret:

```text
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
```

Site key (already in `wrangler.jsonc` vars): `1x00000000000000000000AA`.

These two values are dummy credentials from Cloudflare's Turnstile testing docs. They are not a production widget.

## Owner steps to deploy

From `demos/tanbase`, with the owner account. Unset any other token first:

```bash
cd demos/tanbase
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler whoami

env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler d1 create tech-demos-tanbase
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler r2 bucket create tech-demos-tanbase
```

Put the real D1 `database_id` into `wrangler.jsonc` (the file currently has a placeholder, `00000000-0000-4000-8000-0000000000a1`).

Create a Turnstile widget for `tech-demos.theserverless.dev` and `tanbase.tech-demos.theserverless.dev`. Then:

```bash
# Replace the test site key in wrangler.jsonc vars:
#   "TURNSTILE_SITE_KEY": "<widget site key>"

env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put TURNSTILE_SECRET
# paste the widget secret. Do not commit it.

env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

`bun run deploy` also applies D1 migrations remotely. The first remote migrate needs the real database id.

Workers AI, Workflows, Durable Objects, and the rate-limit namespaces (`7351`, `7352`, `7353`) are created by the deploy. No extra token beyond the owner login.

After the Worker is on the zone routes, redeploy the hub so the gallery card is present:

```bash
bun run --filter @tech-demos/hub deploy
```

## Routes

- `tech-demos.theserverless.dev/demos/tanbase*`
- `tanbase.tech-demos.theserverless.dev/*`

## What stays stubbed

- Reminder delivery is a D1 log line. Nothing is emailed.
- If Workers AI returns something other than 3–6 JSON subtasks, the workflow writes four fixed fallback subtasks and says so in the drawer.
