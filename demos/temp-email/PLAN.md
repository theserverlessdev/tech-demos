# Plan — temp-email

## Goal

A visitor mints a disposable address on `email.lomvic.com` and reads the mail that arrives there. An agent does the same through an API with a shared key.

The demo is a small slice of [hirotomasato/tempik](https://github.com/hirotomasato/tempik). It is not a full agent inbox.

## Mail safety rule

Inbound demo mail lives on the throwaway zone `lomvic.com` (subdomain `email.lomvic.com`). Do **not** touch apex MX on `theserverless.dev` — that zone stays on Google Workspace.

- Email Routing is enabled on `lomvic.com` only.
- MX / SPF for this demo are on `email.lomvic.com` only.
- Never run `wrangler email routing enable theserverless.dev` (that would replace Google apex MX with Cloudflare).
- Mail previously planned for `test-email.theserverless.dev` moved off TSD; hub gallery links still use `tech-demos.theserverless.dev`.

## Single-user MVP

- In:
  - One Worker with three handlers: `email()` for inbound mail, `fetch()` for the UI and the API, and `scheduled()` for cleanup.
  - D1 tables for inboxes and messages. Each inbox has an expiry time. A cron job deletes expired rows every 15 minutes.
  - Mint a random address or a custom name. List messages. Show the HTML part and the text part. Delete a message or an inbox. Add time to an inbox.
  - An inbox token (bearer) for the browser. A shared agent key (bearer) for agents.
  - Agent calls: create an inbox, list messages, read a message, wait for new mail (long poll), and deliver raw MIME for tests.
  - One-time codes and links in each message, for agents that must pass a sign-up check.
  - A "Send sample" button. It runs the same parser and storage as `email()`, so a visitor can see the flow before MX is live.
  - A status banner that reads the live MX record through DNS over HTTPS.
  - Graphite & Ember UI that matches the hub.
- Out:
  - Outbound mail and replies.
  - Attachment storage. The demo keeps only the attachment name, type, and size.
  - User accounts. The browser keeps its inbox tokens in `localStorage`.
  - Forwarding to real mailboxes.

## Tasks

1. D1 schema and migration: `inboxes`, `messages`, and indexes on expiry and on the message cursor.
2. Ingest module: check the size, parse with PostalMime, cap the bodies, find codes and links, and insert the row.
3. `email()` handler: accept only `@email.lomvic.com`, drop `+tag`, reject unknown, expired, full, or large mail.
4. HTTP API under `/api/v1` with bearer auth and rate limits.
5. `scheduled()` cleanup.
6. Browser UI: address card, inbox switcher, message list, sandboxed HTML viewer, text view, details view.
7. Deploy: D1 database, secret, custom domain, hub routes.
8. Email Routing: read the settings and the required records. Stop before any change to the apex MX records. Write SETUP.md.
9. Register the demo in the hub and in `tracking/seen.json`.
10. Smoke script, screenshots, and a video.

## Stack

- **Workers + Static Assets:** the UI is static, and the Worker runs first for `/api`.
- **Email Workers (`email()`):** Email Routing sends each message to the Worker as a stream.
- **D1:** two tables with simple queries. D1 is on the Paid plan, and a demo inbox uses fewer than 60 rows.
- **postal-mime:** the MIME parser that tempik and the Cloudflare docs use.
- **Workers rate limiting binding:** caps the creates and the reads for each IP address with no extra storage.
- **Cron trigger:** deletes expired rows. No Durable Object alarm is necessary.
- **No framework:** the router has fewer than 20 routes, so plain `URLPattern`-style matching is enough.

## Security

- HTML mail renders in an `<iframe sandbox>` with no scripts and an opaque origin. A CSP in the frame blocks remote images until the visitor allows them.
- The server stores only a SHA-256 hash of each inbox token.
- The agent key check uses `crypto.subtle.timingSafeEqual` on hashes.
- Each message is 1 MB or smaller. Each inbox holds 50 messages or fewer. The server cuts the HTML body at 512 KB and the text body at 256 KB.

## Cost

- D1 reads and writes for a demo are far below what the Paid plan includes.
- The long poll checks D1 once each second for 25 seconds or less. A wait that ends with no mail uses about 25 row reads.
- Email Routing is free.

## Deferred

- Attachment download through R2.
- Push updates through a Durable Object WebSocket in place of polling.
- Reply and send through Email Sending.
- An MCP server for agents.

## Productize (2026-09-11)

Hosted demo on `email.lomvic.com` is not a free shared agent API. Self-host is the full product.

### Goal

A visitor still mints a short-TTL inbox in the browser. An agent mints its **own** API key after Cloudflare Turnstile (optional name). The key is shown once, stored hashed, quota-limited, and revocable. The old `AGENT_API_KEY` secret stays **admin/fleet only** so the owner is not locked out.

### In

- D1 `api_keys` plus `inboxes.api_key_id`. Minted keys open only inboxes they created. Admin opens every inbox.
- `POST /api/v1/keys` verifies Turnstile server-side, then returns the plaintext key once.
- Hosted UI: demo/no-SLA banner, acceptable use, short privacy, abuse/Contact. Turnstile-gated mint. Deploy to Cloudflare button.
- Self-host: README/SETUP split, Deploy Button, `wrangler.selfhost.jsonc`, zone MX docs. Operator sets their own admin secret and Turnstile keys.
- Mobile pass: 44px tap targets, usable mint + inbox list, remote-images control stays reachable.
- `CHANGELOG.md` vs [Tempik](https://github.com/hirotomasato/tempik).

### Out

- User accounts, email login, billing.
- Workers for Platforms / dispatch namespaces.
- Changing apex MX on `theserverless.dev`.

### Auth

| Caller | How | Powers |
| --- | --- | --- |
| Web | no bearer, IP rate limit | Create inbox at web TTL. Inbox token (hash) reads that inbox. |
| Minted agent key | `Authorization: Bearer te1_…` after Turnstile mint | Create/read/wait/deliver/extend/delete **own** inboxes. Set `ttlMinutes`. Quotas. |
| Admin `AGENT_API_KEY` | same header, timing-safe compare | Fleet: every inbox, no quota. Not advertised as the public agent path. |

Hosted: mint fails closed without Turnstile secret. Self-host: mint requires Turnstile when the secret is set; otherwise agents use the operator's admin key.
