# Deploy Agent Mail

Deploy only the subdomain `agents.theserverless.dev`.

Do not change MX or SPF on the apex `theserverless.dev`. That zone stays on Google Workspace.

Do not change `mail.theserverless.dev`. That host stays on Mailgun.

Do not click **Onboard domain** for the apex if the preview shows apex MX changes.

The default bootstrap admin is `hello@anks.in`. The Worker reads `ADMIN_EMAIL`. Change the var if you want a different first admin. Do not put the address in code.

## 1. API token

Create a custom token in the Cloudflare dashboard. The dashboard may label a group **Edit** or **Write**. They are the same group.

Account permissions:

- Workers Scripts:Edit
- Workers R2 Storage:Edit
- D1:Edit
- Account Settings:Read
- Workers Tail:Read

User permissions:

- User Details:Read

Zone `theserverless.dev`:

- Workers Routes:Edit
- Zone:Read
- DNS:Edit, only if Wrangler should create the HTTP record for `agents.theserverless.dev`

DNS:Edit can change any record in the zone. Do not use this token to edit apex MX, apex SPF, apex DMARC, or `mail.theserverless.dev`.

Email Sending for the subdomain is an API call, not a dashboard-only step. The deploy token can run:

```bash
bunx wrangler email sending enable agents.theserverless.dev
```

Onboarding writes a DMARC TXT of `v=DMARC1; p=reject` on `_dmarc.agents.theserverless.dev`. Change that to `v=DMARC1; p=none` before you send mail.

Use a separate token for Email Routing rules. See the `CF_ROUTING_TOKEN` section below. Do not add Email Routing Rules:Edit to the deploy token.

Access app setup stays on a dashboard login: Account > Access: Apps and Policies:Edit.

Export the token as `CLOUDFLARE_API_TOKEN`. Export `CLOUDFLARE_ACCOUNT_ID`.

## 2. Create resources

From `services/agent-mail`:

```bash
bunx wrangler d1 create agent-mail
bunx wrangler r2 bucket create agent-mail
```

The D1 `database_id` in `wrangler.jsonc` is `b82ef780-1715-4987-a6e5-841b0b5c7aa9`. That id is not a secret.

The R2 bucket name is `agent-mail`. The Worker name is `agent-mail`.

## 3. Email Routing on the subdomain

Open Email Routing for the zone `theserverless.dev`.

Enable the subdomain `agents`. The MX records must land on `agents.theserverless.dev` only.

Do not enable routing on the apex.

A wildcard rule does not deliver mail on a subdomain. The API accepts `*@agents.theserverless.dev`, and the dashboard may save it, but catch-all is apex-only. Mail to that pattern never arrives. Each inbox needs its own literal rule, for example `rescue@agents.theserverless.dev` → Worker `agent-mail`.

When `CF_ROUTING_TOKEN` is set, creating an inbox in the panel or `POST /admin/agents/:id/inboxes` creates that literal rule. Disabling the inbox disables the rule. Deleting an empty inbox deletes the rule. If the token is unset, the inbox is still created. The agent page then shows `routing rule missing: add it in Cloudflare` and the exact rule to add by hand.

The Worker still accepts only local-parts that exist in D1. Unknown addresses are rejected or quarantined. A plus tag such as `rescue+notes@` uses the `rescue` inbox and the same literal rule.

Leave the MX and SPF records the Routing page writes on the subdomain. Keep the host names the dashboard shows if they differ.

| Type | Name | Content | Notes |
| --- | --- | --- | --- |
| MX | `agents.theserverless.dev` | `route1.mx.cloudflare.net` | Priority from the dashboard |
| MX | `agents.theserverless.dev` | `route2.mx.cloudflare.net` | Priority from the dashboard |
| MX | `agents.theserverless.dev` | `route3.mx.cloudflare.net` | Priority from the dashboard |
| TXT | `agents.theserverless.dev` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | Routing SPF. Do not merge this into the apex SPF. |

Turning subdomain routing on also writes a read-only TXT at `cf2024-1._domainkey.theserverless.dev` (the apex, not the subdomain). Do not edit or delete it. The zone-level Email Routing status then shows `misconfigured`, because the apex MX is Google Workspace. Both of those are expected. Do not turn on apex routing to clear that status.

## 4. Email Sending

Enable Email Sending for the subdomain. Do not onboard the apex.

```bash
bunx wrangler email sending enable agents.theserverless.dev
```

That command is enough. You do not have to finish sending setup only in the dashboard.

Onboarding writes DMARC as `p=reject`. Change `_dmarc.agents.theserverless.dev` to `v=DMARC1; p=none` before the first send.

Leave the records the onboarding screen writes. They look like this:

| Type | Name | Content | Notes |
| --- | --- | --- | --- |
| MX | `cf-bounce.agents.theserverless.dev` | Host from the dashboard | Bounce MX |
| TXT | `cf-bounce.agents.theserverless.dev` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | Sending SPF. This name is not the routing SPF name. |
| TXT | `cf-bounce._domainkey.agents.theserverless.dev` | Value from the dashboard | Sending DKIM |
| TXT | `_dmarc.agents.theserverless.dev` | `v=DMARC1; p=none;` | Onboarding writes `p=reject`. Change it to `p=none` at the start. |

Do not edit `_dmarc.theserverless.dev`.

The Worker binding `EMAIL` is not restricted to a sender list. New inboxes would need a redeploy if it were. The Worker sends only from `{local-part}@agents.theserverless.dev`.

## 5. HTTP route

`wrangler.jsonc` contains:

```json
{ "pattern": "agents.theserverless.dev", "custom_domain": true }
```

This creates an HTTP DNS record only. It does not change MX.

`workers_dev` is false. The public origin is `https://agents.theserverless.dev`.

## 6. Access for /admin

Create a self-hosted Access application.

- Team domain: `theserverlessdev.cloudflareaccess.com`
- Application domain: `agents.theserverless.dev`
- Path: `/admin`

Do not protect `/`, `/health`, `/v1`, or the email handler. Agents call `/v1` with a bearer key. Email Routing calls the email handler. Those paths must not require Access.

Policy example:

- Action: Allow
- Include: Emails
- Value: `hello@anks.in`

Add more emails when you invite more people. Access alone is not enough. The email must also exist in D1, or it must equal `ADMIN_EMAIL` on the first login.

The application AUD tag is already in `POLICY_AUD`: `3d1c9fc7ef7c5c384934b5edd070862ba4405742c2a020a449cd907f4fb54574`. That value is an id, not a secret.

The issuer is `https://theserverlessdev.cloudflareaccess.com` (`TEAM_DOMAIN`).

## 7. Vars and the secret

Vars in `wrangler.jsonc`:

| Name | Default |
| --- | --- |
| `MAIL_DOMAIN` | `agents.theserverless.dev` |
| `PUBLIC_ORIGIN` | `https://agents.theserverless.dev` |
| `TEAM_DOMAIN` | `https://theserverlessdev.cloudflareaccess.com` |
| `POLICY_AUD` | `3d1c9fc7ef7c5c384934b5edd070862ba4405742c2a020a449cd907f4fb54574` |
| `ADMIN_EMAIL` | `hello@anks.in` |
| `CF_ZONE_ID` | Zone id of `theserverless.dev`. Replace `replace-with-zone-id`. |
| `ROUTING_WORKER_NAME` | `agent-mail` |

`ADMIN_EMAIL` is the bootstrap address. The first valid Access login with that email creates the admin row. An empty value creates nobody. Change the var before that first login if you want a different admin.

Set the secret. Do not commit it.

```bash
openssl rand -hex 32
bunx wrangler secret put WEBHOOK_KEY
```

`WEBHOOK_KEY` encrypts webhook secrets and signs panel forms.

Optional routing token. Create a second token with only this permission:

- Zone `theserverless.dev`: Email Routing Rules:Edit

```bash
bunx wrangler secret put CF_ROUTING_TOKEN
```

Put the zone id of `theserverless.dev` in `CF_ZONE_ID` before you set the secret. The zone id is on the zone Overview page. `ROUTING_WORKER_NAME` is `agent-mail`.

When the secret is unset, inbox create still succeeds. The panel shows `routing rule missing: add it in Cloudflare` and the literal rule, for example `rescue@agents.theserverless.dev -> worker agent-mail`.

Never set `ENVIRONMENT=test` in production. That switch trusts the test signing key.

## 8. Deploy and smoke

Wrangler needs Node.js 22 or newer. Bun runs the tests. Wrangler itself still uses Node.

```bash
cd services/agent-mail
bun install
bun run deploy
bun run smoke
```

`bun run deploy` applies D1 migrations, including `0002_routing_rule.sql`, then deploys the Worker.

`bun run deploy` uses the top-level Worker config. It does not use the `dev` environment. The `dev` environment is only for `bun run dev` on your machine.

Optional: `SMOKE_API_KEY` calls `GET /v1/me` after you mint a key in the panel. `SMOKE_ORIGIN` defaults to `https://agents.theserverless.dev`.

The smoke script checks:

- `GET /health` returns `{ "ok": true, "service": "agent-mail" }`
- `GET /v1/openapi.json` returns OpenAPI 3.1
- `GET /admin` returns `403` from the Worker, or `302` when Access sends the browser to login

## 9. First login

1. Open `https://agents.theserverless.dev/admin`.
2. Sign in through Access as `hello@anks.in` (or the email in `ADMIN_EMAIL`).
3. The Worker inserts that user with role `admin`.
4. Create an agent, an inbox, and an API key. The key is shown once.
5. If `CF_ROUTING_TOKEN` is set, the new inbox already has a literal routing rule. If the page says `routing rule missing`, add that exact rule in Cloudflare Email Routing.
6. Send a test message to the inbox. Confirm it in **Mail**.
7. Set the agent policy to `draft`, send from the API, and approve the draft.

Invite more people from **Users**. A user sees only their own agents and inboxes.
