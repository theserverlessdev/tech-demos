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

There is no Email Sending permission in the token catalog. Domain setup for sending is a dashboard task. The `send_email` binding deploys with Workers Scripts:Edit.

Use a separate dashboard login for these tasks. They are not required on the deploy token:

- Account: Email Routing Addresses:Edit
- Zone `theserverless.dev`: Email Routing Rules:Edit
- Account: Access: Apps and Policies:Edit

Export the token as `CLOUDFLARE_API_TOKEN`. Export `CLOUDFLARE_ACCOUNT_ID`.

## 2. Create resources

From `services/agent-mail`:

```bash
bunx wrangler d1 create agent-mail
bunx wrangler r2 bucket create agent-mail
```

Put the D1 `database_id` into `wrangler.jsonc`. The placeholder id is `00000000-0000-0000-0000-000000000000`.

The R2 bucket name is `agent-mail`. The Worker name is `agent-mail`.

## 3. Email Routing on the subdomain

Open Email Routing for the zone `theserverless.dev`.

Enable the subdomain `agents`. The MX records must land on `agents.theserverless.dev` only.

Do not enable routing on the apex.

The catch-all toggle is for the apex only (docs checked 2026-09-25). For this subdomain, add a routing rule:

- Custom address `*@agents.theserverless.dev` → Worker `agent-mail`

If the dashboard rejects the wildcard, add one literal rule per inbox, for example `rescue@agents.theserverless.dev` → Worker `agent-mail`. Add a new rule each time you create an inbox.

The Worker still accepts only local-parts that exist in D1. Unknown addresses are rejected or quarantined.

Leave the DNS records the Routing page writes. They look like this. Keep the host names the dashboard shows if they differ (for example `amir.mx.cloudflare.net`).

| Type | Name | Content | Notes |
| --- | --- | --- | --- |
| MX | `agents.theserverless.dev` | `route1.mx.cloudflare.net` | Priority from the dashboard |
| MX | `agents.theserverless.dev` | `route2.mx.cloudflare.net` | Priority from the dashboard |
| MX | `agents.theserverless.dev` | `route3.mx.cloudflare.net` | Priority from the dashboard |
| TXT | `agents.theserverless.dev` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | Routing SPF. Do not merge this into the apex SPF. |
| TXT | `cf2024-1._domainkey.agents.theserverless.dev` | Value from the dashboard | Routing DKIM. Do not invent the value. |

## 4. Email Sending

Onboard the subdomain `agents.theserverless.dev` for Email Sending. Do not onboard the apex.

Leave the records the onboarding screen writes. They look like this:

| Type | Name | Content | Notes |
| --- | --- | --- | --- |
| MX | `cf-bounce.agents.theserverless.dev` | Host from the dashboard | Bounce MX |
| TXT | `cf-bounce.agents.theserverless.dev` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | Sending SPF. This name is not the routing SPF name. |
| TXT | `cf-bounce._domainkey.agents.theserverless.dev` | Value from the dashboard | Sending DKIM |
| TXT | `_dmarc.agents.theserverless.dev` | `v=DMARC1; p=none;` | Start here. The onboard flow may write `p=reject`. |

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

Copy the application AUD tag into the `POLICY_AUD` var. Replace `replace-with-access-aud-tag`.

The issuer is `https://theserverlessdev.cloudflareaccess.com` (`TEAM_DOMAIN`).

## 7. Vars and the secret

Vars in `wrangler.jsonc`:

| Name | Default |
| --- | --- |
| `MAIL_DOMAIN` | `agents.theserverless.dev` |
| `PUBLIC_ORIGIN` | `https://agents.theserverless.dev` |
| `TEAM_DOMAIN` | `https://theserverlessdev.cloudflareaccess.com` |
| `POLICY_AUD` | Access AUD tag |
| `ADMIN_EMAIL` | `hello@anks.in` |

`ADMIN_EMAIL` is the bootstrap address. The first valid Access login with that email creates the admin row. An empty value creates nobody. Change the var before that first login if you want a different admin.

Set the secret. Do not commit it.

```bash
openssl rand -hex 32
bunx wrangler secret put WEBHOOK_KEY
```

`WEBHOOK_KEY` encrypts webhook secrets and signs panel forms.

Never set `ENVIRONMENT=test` in production. That switch trusts the test signing key.

## 8. Deploy and smoke

```bash
cd services/agent-mail
bun install
bun run deploy
bun run smoke
```

`bun run deploy` applies D1 migrations on the remote database, then deploys the Worker.

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
5. Add an Email Routing rule for that inbox if the wildcard rule is not active.
6. Send a test message to the inbox. Confirm it in **Mail**.
7. Set the agent policy to `draft`, send from the API, and approve the draft.

Invite more people from **Users**. A user sees only their own agents and inboxes.
