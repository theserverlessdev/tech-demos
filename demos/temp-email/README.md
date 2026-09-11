# Temp email

Disposable inboxes. Two ways to run it:

| | **Hosted demo** | **Your Cloudflare (self-host)** |
| --- | --- | --- |
| URL | <https://email.lomvic.com> | Your workers.dev or custom domain |
| Mail | `@email.lomvic.com` | Your zone + MX (see [SETUP.md](./SETUP.md)) |
| Agent API | Mint a **per-agent key** after Turnstile. Not a shared secret. | You set Turnstile + an admin secret. Full product. |
| Rules | Demo / no SLA, short TTL, rate limits, acceptable use | Yours |

- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs Tempik:** [CHANGELOG.md](./CHANGELOG.md)
- **Owner + self-host steps, agent API:** [SETUP.md](./SETUP.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/theserverlessdev/tech-demos/tree/main/demos/temp-email)

The button clones `demos/temp-email`. Set `MAIL_DOMAIN`, `PUBLIC_ORIGIN`, `HOSTED_MODE=false`, Turnstile keys, and `AGENT_API_KEY` (admin only). Create an **R2 bucket** for attachments (`wrangler r2 bucket create …` and set `r2_buckets[0].bucket_name`). Then attach Email Routing — details in SETUP. If the button cannot apply this monorepo subdirectory cleanly, copy the folder and run `bun run deploy:selfhost` with [wrangler.selfhost.jsonc](./wrangler.selfhost.jsonc).

## How it works

```text
sender ─► Cloudflare MX ─► Email Routing catch-all ─► email() ─► postal-mime ─► D1 (meta) + R2 (attachment bytes)
browser ─► /api/v1 (inbox token) ──────────────┐
agent   ─► /api/v1 (minted key, after Turnstile) ┴► fetch() ─► D1 / R2
admin   ─► /api/v1 (AGENT_API_KEY, fleet only) ─┘     ▲
scheduled() deletes expired inboxes + R2 prefixes every 15 minutes ─┘
```

1. A visitor presses **New address**. The Worker writes an inbox row with an expiry time and returns a random token. The browser keeps the token in `localStorage`.
2. Email Routing sends each message for the mail domain to `email()`. The handler rejects other domains, unknown or expired inboxes, full inboxes, and messages over 1 MB.
3. `ingest()` parses the MIME, cuts large bodies, finds one-time codes and links, writes attachment bytes to R2, and inserts D1 metadata.
4. The page asks for new messages every 5 seconds. HTML mail renders in a sandboxed frame with no scripts. Remote images stay blocked until the visitor allows them. Attachment download uses the inbox token.
5. An agent **mints a key** (Turnstile + optional name). The key is shown once. `wait` long-polls until the next message with its codes.

**Send sample** and the agent `deliver` call run the same `ingest()` path as SMTP.

## Notices

- Demo / no SLA. Mail may drop. Testing only.
- No fraud, spam, phishing, or ToS-laundering at scale.
- Inbound mail is kept briefly and deleted on TTL or inbox delete.
- Abuse: [abuse@lomvic.com](mailto:abuse@lomvic.com) · [Contact](https://theserverless.dev/contact)

## Files

| Path | Purpose |
| --- | --- |
| `src/worker/index.ts` | `fetch()`, `email()`, `scheduled()`, page CSP, and hub redirects |
| `src/worker/api.ts` | `/api/v1` routes, auth, rate limits, and the long poll |
| `src/worker/keys.ts` | Minted API keys in D1 |
| `src/worker/turnstile.ts` | Siteverify for key mint |
| `src/worker/attachments.ts` | R2 put/get/list+delete for attachment bytes |
| `src/worker/ingest.ts` | MIME to D1 row + R2 objects, and the sample message |
| `src/client/app.ts` | Browser UI |
| `migrations/` | D1 schema |
| `wrangler.selfhost.jsonc` | Template without lomvic/TSD routes |
| `scripts/smoke.ts` | End-to-end checks for local or live |
