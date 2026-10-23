# Plan — r2-drive

## Goal

Show that a stateful file protocol (WebDAV Class 1 and Class 2, including LOCK and UNLOCK) can run on Workers: an isolated R2 prefix per visitor, locks in a SQLite Durable Object, and a cron that deletes the drive when the hour is up.

## Single-user MVP

- In:
  - A port of [abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav) (Apache-2.0) with attribution, LICENSE, and CHANGELOG.
  - Turnstile plus a one-time email link before mint. One active drive per normalized email. Password hashed at rest.
  - Caps: 25 MB per drive, 200 files, 5 MB per file. TTL 60 minutes. Cron, a Durable Object alarm, and an on-request wipe. R2 lifecycle file is the day-scale backstop.
  - Magic-byte allow list (text, markdown, JSON, CSV, PDF, small office). Images, audio, video, archives, and unknown binaries get 415.
  - No share links, no anonymous GET of bytes, no CORS, `Cache-Control: private, no-store`.
  - Browser file UI, live WebSocket log, lock owner / timeout / depth, mount snippets, litmus page that only shows a real run.
  - Audit row (email HMAC, encrypted email, IP hash) kept 30 days after wipe. A misuse report freezes and blocks. Admin kill switch. `MINT_ENABLED` defaults off in code and on in wrangler.
- Out:
  - Deploy, real D1 / R2 / Turnstile / Email Sending resources.
  - Share links, public downloads, image or media hosting.
  - CalDAV, versioning, accounts beyond one email.

## Tasks

1. Confine paths and port PROPFIND, GET, PUT, MKCOL, DELETE, COPY, MOVE, LOCK, UNLOCK.
2. Mint, verify, caps, TTL wipe, content policy, audit, report, and admin freeze.
3. Static UI, hub registry copy, tests, typecheck, smoke.
4. Run litmus if the tool is available and record the raw output. Leave the page empty of results when it is not.

## Stack

- Workers + Static Assets + R2 + D1 + SQLite Durable Objects + Rate Limiting + Turnstile + Email Sending: the protocol, the locks, the audit log, and the magic link all fit on Workers Paid.
- `@xmldom/xmldom` 0.9.12: same XML parser family as upstream, so PROPFIND and LOCK bodies stay compatible. 0.9 reports parse errors through `onError` instead of an error-handler object.
- Disposable domains vendored from disposable-email-domains (CC0): a soft signal, not a guarantee.
- Bun test with in-memory bucket and lock store: the protocol tests do not need a live account.

## Deferred

- Litmus `http` suite (upstream skips it; local Workers time out on `Expect: 100-continue`).
- Sub-day R2 lifecycle. The lifecycle API is day-scale, so the hour is enforced in the Worker.
- Decrypt-from-dashboard tooling. Admin audit is the support path.
