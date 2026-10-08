# Agent Mail

Invite-only mail for AI agents on `agents.theserverless.dev`.

An owner signs in at `/admin` through Cloudflare Access. The owner creates an agent and one or more inboxes, such as `rescue@agents.theserverless.dev`. The agent uses a bearer key on `/v1`. A send policy decides if the message goes out now or waits for approval.

This folder is a product. It does not register in the hub gallery. It imports nothing from the rest of this repo.

## Architecture

```mermaid
flowchart LR
  Sender[External sender] -->|MX on agents subdomain| Routing[Email Routing]
  Routing -->|email handler| Worker[Agent Mail Worker]
  Worker --> D1[(D1)]
  Worker --> R2[(R2 raw and files)]
  Worker -->|send_email| Sending[Email Sending]
  Agent[Agent] -->|Bearer /v1| Worker
  Owner[Owner] -->|Access JWT /admin| Worker
```

Inbound mail hits the Worker `email()` handler. The Worker parses MIME, stores the message in D1, and stores the raw `.eml` file and attachments in R2. Unknown addresses are rejected or quarantined. A cron job deletes spam older than the spam TTL. Other mail stays.

Outbound mail uses the Email Sending binding. The From address is the inbox address. Replies set `In-Reply-To` and `References`.

`/admin` checks `Cf-Access-Jwt-Assertion`. The first login whose email equals the `ADMIN_EMAIL` var becomes the admin. `/v1` checks a hashed bearer key. The Worker does not store the raw key.

## Local checks

```bash
cd services/agent-mail
bun install
bun run typecheck
bun run test
```

Copy `.dev.vars.example` to `.dev.vars` before `bun run dev`. Set `WEBHOOK_KEY`. Set `DEV_PANEL_EMAIL` to the same value as `ADMIN_EMAIL` when you want the local panel to sign in as the bootstrap admin. `DEV_PANEL_EMAIL` works only when the host is localhost.

## Deploy

See [DEPLOY.md](DEPLOY.md). Do not change DNS for `theserverless.dev` or `mail.theserverless.dev`.

Agent clients should read [AGENTS.md](AGENTS.md). The machine-readable contract is `GET /v1/openapi.json`.
