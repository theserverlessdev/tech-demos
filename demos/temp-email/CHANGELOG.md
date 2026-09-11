# Changelog — temp-email vs Tempik

This demo is a slice of [hirotomasato/tempik](https://github.com/hirotomasato/tempik), not a drop-in fork. Tempik is a self-hosted disposable mailbox. This repo is a **hosted demo** on `email.lomvic.com` plus a **self-host** path on the visitor’s Cloudflare account.

## Architecture

| | Tempik | This demo |
| --- | --- | --- |
| Runtime | Cloudflare Workers + Assets | Same |
| Inbound mail | Email Workers `email()` | Same |
| MIME | postal-mime | Same |
| Store | D1: inboxes, messages, **sessions**, session_inboxes | D1: inboxes, messages, **api_keys**. No browser session table. |
| HTTP | Hono | Plain `fetch()` router (`/api/v1`) |
| Config | `wrangler.toml` | `wrangler.jsonc` |
| Cleanup | Not a cron in the upstream README | `scheduled()` every 15 minutes deletes expired inboxes |
| Rate limits | Unspecified in upstream README | Workers rate-limit binding per IP (and per minted key) |
| UI | Tempik dark theme | Graphite & Ember (`#c2410c` on `#0e0e11`), matching the hub |

## Auth

Tempik ties inboxes to a **browser session** cookie/token.

This demo uses three callers:

1. **Web** — no bearer. Create at short TTL. The create response returns an **inbox token** once; the server stores SHA-256. The browser keeps tokens in `localStorage`.
2. **Minted agent key** — Turnstile-gated `POST /api/v1/keys`. Key shown once, stored hashed, quota + revoke. Bearer opens **only inboxes that key created**. Can set `ttlMinutes`, long-poll `wait`, and `deliver` raw MIME for tests.
3. **Admin `AGENT_API_KEY`** — owner/fleet bootstrap. Timing-safe compare. Opens every inbox. **Not** the public agent path.

Hosted mode is not a free open agent API with a shared secret.

## Agent API (not in Tempik)

- `GET /inboxes/{address}/wait` — long poll, full messages, extracted `codes` and `links`
- `POST /inboxes/{address}/sample` and `/deliver` — same `ingest()` path as SMTP
- One-time code and link extraction for sign-up agents

## Hosting model

- **Hosted:** `email.lomvic.com` on throwaway zone `lomvic.com`. Demo / no SLA, short TTL, Turnstile mint, legal notices. Do **not** touch apex MX on `theserverless.dev` (Google Workspace).
- **Self-host:** Deploy to Cloudflare button + `wrangler.selfhost.jsonc`. Operator sets `MAIL_DOMAIN`, Turnstile keys, and their own admin secret. Full Email Worker + D1 + agent API on their account.

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. No purple-to-cyan logo.
