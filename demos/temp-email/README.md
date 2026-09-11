# Temp email

Disposable inboxes on `email.lomvic.com`, inspired by [hirotomasato/tempik](https://github.com/hirotomasato/tempik).

- **Live:** <https://email.lomvic.com>
- **Plan:** [PLAN.md](./PLAN.md)
- **Setup, owner steps, and the agent API:** [SETUP.md](./SETUP.md)

## How it works

```text
sender ─► Cloudflare MX (email.lomvic.com) ─► Email Routing catch-all ─► email() ─► postal-mime ─► D1
browser ─► /api/v1 (inbox token) ─┐
agent   ─► /api/v1 (agent key)  ──┴► fetch() ─► D1 ◄─ scheduled() deletes expired inboxes every 15 minutes
```

1. A visitor presses **New address**. The Worker writes an inbox row with an expiry time and returns a random token. The browser keeps the token in `localStorage`.
2. Email Routing sends each message for the subdomain to `email()`. The handler rejects other domains, unknown or expired inboxes, full inboxes, and messages over 1 MB.
3. `ingest()` parses the MIME, cuts large bodies, finds one-time codes and links, and inserts one row.
4. The page asks for new messages every 5 seconds. HTML mail renders in a sandboxed frame with no scripts. Remote images stay blocked until the visitor allows them.
5. An agent calls `wait`, a long poll that returns the next message with its codes.

**Send sample** and the agent `deliver` call run the same `ingest()` path as SMTP. You can use them to test the demo before MX is live.

## Files

| Path | Purpose |
| --- | --- |
| `src/worker/index.ts` | `fetch()`, `email()`, `scheduled()`, page CSP, and hub redirects |
| `src/worker/api.ts` | `/api/v1` routes, auth, rate limits, and the long poll |
| `src/worker/ingest.ts` | MIME to row, and the sample message |
| `src/worker/extract.ts` | Snippets, codes, and links |
| `src/worker/db.ts` | D1 queries |
| `src/client/app.ts` | Browser UI |
| `migrations/0001_init.sql` | D1 schema |
| `scripts/smoke.ts` | End-to-end checks for local or live |
