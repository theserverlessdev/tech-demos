# R2 Drive

A one-hour WebDAV drive on Cloudflare Workers. The pattern is a stateful file protocol running properly at the edge: Class 1 and Class 2 (including `LOCK` / `UNLOCK`) against an isolated R2 prefix, with lock state in a SQLite Durable Object.

What you can try: verify an email, accept the use rules, and mount the drive from macOS Finder, Windows Explorer, rclone, or Obsidian Remotely Save. The page also uploads, renames, moves, deletes, and previews text and PDF, and it shows the lock owner, timeout, and depth on a live request log.

What you could build with the same pattern: a personal Dropbox-style drive, an Obsidian or Zotero sync target, or a backup destination for rclone.

This demo is a port of [abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav) (Apache-2.0). See `NOTICE`, `LICENSE`, and `CHANGELOG.md`. Abuse rules are in `ABUSE.md`.

## Run

From the repo root:

```sh
bun install
bun run --filter @tech-demos/r2-drive dev
```

That listens on <http://127.0.0.1:8808>. Local dev writes `.dev.vars` with Cloudflare's published Turnstile test pair and `EMAIL_SINK=1`. Open the page, mint with any non-disposable address, then use **Use the latest link**. The dev mailbox is served only on loopback, and only when both `EMAIL_SINK=1` and `TURNSTILE_LOCAL=1`.

```sh
bun run --filter @tech-demos/r2-drive test
bun run --filter @tech-demos/r2-drive typecheck
bun run --filter @tech-demos/r2-drive smoke
```

`smoke` expects the dev server. The repo-root `bun test` script lists other demos explicitly and does not include this one.

## Placeholders

Nothing here is deployed. Replace these before a real deploy:

| Binding | Placeholder |
| --- | --- |
| D1 `DB` | `database_id` `00000000-0000-4000-8000-0000000000d2`, name `r2-drive-placeholder` |
| R2 `BUCKET` | `r2-drive-placeholder` |
| Turnstile | `TURNSTILE_SITE_KEY` is empty in `wrangler.jsonc`. Secret `TURNSTILE_SECRET` |
| Email Sending | `MAIL_FROM` is `drive@example.invalid`. Binding `EMAIL` |
| Audit | secrets `AUDIT_KEY` and `AUDIT_HMAC_KEY`, each 32 bytes hex |
| Admin | secret `ADMIN_TOKEN` |

`MINT_ENABLED` defaults to off in code (`envMintEnabled` is true only for the string `"true"`). `wrangler.jsonc` sets it to `"true"` for this demo's deploy config. An admin can still turn minting off at runtime.

Apply the R2 backstop after the bucket exists:

```sh
npx wrangler r2 bucket lifecycle set r2-drive-placeholder --file lifecycle.json
```

The rule expires objects under `drives/` after one day. R2 lifecycle is day-scale, so the hour is enforced by the request path, the Durable Object alarm, and the `*/5` cron. The lifecycle rule is the backstop if those miss. Bytes can linger until the daily rule runs; they are not readable without the dead credential.

## Caps and content

25 MB per drive, 5 MB per file, 200 objects, one hour. `PUT` walks one list in `src/shared/content-policy.ts` and checks magic bytes. Text, Markdown, JSON, CSV, PDF, and small Office documents are allowed. Images, video, audio, archives (zip, 7z, rar, tar, gz), and encrypted or unknown binaries are rejected with 415. A Word file is a zip; only an Office package with no media parts gets through.

The disposable-domain check uses a vendored copy of [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) (`disposable_email_blocklist.conf`, CC0). It is a **soft signal**: the list is incomplete and it can mis-label a real domain. Matching is exact, so a subdomain of a listed domain is not implied.

## Mount

After verify, the page prints snippets for Finder, `net use`, rclone, and Obsidian. The username is the drive id. The password is shown once. There is no public URL for a file.
