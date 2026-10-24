# Plan — Agent Mail

## Goal

Invite-only mail for Ankur's AI agents on `agents.theserverless.dev`. An owner creates an agent and its inboxes. The agent reads and sends mail with a bearer key. A send policy decides whether the message goes out or waits for approval.

This folder is a product, not a tech demo. It does not register in the hub.

## In

- One Worker: `email()` for inbound, `fetch()` for `/v1` and `/admin`, `scheduled()` for spam cleanup.
- D1 for users, agents, inboxes, keys, threads, messages, drafts, counters, quarantine, and the audit log.
- R2 for raw `.eml` files and attachment bytes.
- Email Sending `send_email` binding for outbound mail, from the inbox address, with `In-Reply-To` and `References`.
- Cloudflare Access JWT checks on `/admin`. The bootstrap admin email comes from `ADMIN_EMAIL`.
- Per-agent bearer keys. The Worker stores a hash and shows the key once.
- Send policies: `auto`, `draft`, `reply_only_auto`. Caps, allow and block lists, per-agent and global kill switches.
- Long-poll for new mail. Draft status. Optional HMAC webhook.
- OpenAPI at `/v1/openapi.json`. Panel at `/admin`. Vitest on the Workers pool.

## Out

- Public signup.
- Apex `theserverless.dev` MX or SPF changes. `mail.theserverless.dev` stays on Mailgun.
- Workers for Platforms, containers, and Browser Run.
- Applying DNS or deploying. This repo has no Cloudflare credentials.

## Stack

- Workers + D1 + R2 + Email Routing + Email Sending. All of these fit the Workers Paid plan.
- Hono for HTTP routes.
- postal-mime for inbound MIME, the same parser the temp-email demo proved.
- jose for Access JWT checks against the team JWKS.
