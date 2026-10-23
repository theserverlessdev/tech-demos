# R2 Drive

A short-lived sandbox for testing WebDAV with small documents. Class 1 and Class 2 (including `LOCK` / `UNLOCK`) run against an isolated R2 prefix, with lock state in a SQLite Durable Object. Only text, PDF and office documents are accepted. Drives are private and wiped within an hour. Misuse can be reported, and drives can be frozen.

What you can try: verify an email, accept the notice, and mount the drive from macOS Finder, Windows Explorer, rclone, or Obsidian Remotely Save. The page also uploads, renames, deletes, and previews text and PDF, and it shows the lock owner, timeout, and depth on a live request log.

```mermaid
sequenceDiagram
  participant Browser
  participant Worker
  participant Turnstile
  participant Email
  participant DO as DriveObject
  participant D1
  participant R2
  Browser->>Worker: POST /api/mint
  Worker->>Turnstile: siteverify
  Turnstile-->>Worker: hostname check
  Worker->>Email: magic link
  Browser->>Worker: POST /api/verify
  Worker->>D1: insert drive, count the daily mint
  Worker->>DO: schedule(expiresAt)
  Browser->>Worker: WebDAV
  Worker->>Worker: credential, per-drive limit, global DAV ceiling
  Worker->>DO: authed request
  DO->>DO: serialise the write, reserve quota
  DO->>R2: put or delete
  DO->>D1: audit row, usage when it changed
  DO->>R2: alarm wipe at expiresAt
  Worker->>R2: cron wipe of expired drives
  Note over R2: lifecycle.json deletes drives/ after one day
```

What you could build with the same pattern: a personal Dropbox-style drive, an Obsidian or Zotero sync target, or a backup destination for rclone.

This demo is a port of [abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav) (Apache-2.0). See `NOTICE`, `LICENSE`, and `CHANGELOG.md`. The sandbox limits are in `SAFETY.md`.

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

`MINT_ENABLED` is `"false"` in `wrangler.jsonc`. `envMintEnabled` is true only for the string `"true"`. Local `bun run dev` passes `--var MINT_ENABLED:true`. Turn it on in the deploy environment when the placeholders below are real. An admin can still turn minting off at runtime, and cannot turn it on while the env value is not `"true"`.

Deploy applies the R2 backstop after the Worker upload. Replace the bucket name first:

```sh
bun run --filter @tech-demos/r2-drive deploy
```

That runs `bunx wrangler r2 bucket lifecycle set r2-drive-placeholder --file lifecycle.json`. The same command is `bun run --filter @tech-demos/r2-drive lifecycle`.

The rule expires objects under `drives/` after one day. R2 lifecycle is day-scale, so the hour is enforced by the request path, the Durable Object alarm, and the `*/5` cron. The lifecycle rule is the backstop if those miss. Bytes can linger until the daily rule runs; they are not readable without the dead credential.

## Caps and content

25 MB per drive, 5 MB per file, 200 objects, one hour. `PUT` walks one list in `src/shared/content-policy.ts`. Text, Markdown, JSON, CSV, and PDF are allowed. Office files are allowed only when every ZIP part is `.xml` or `.rels`, inflates under 1 MB, and is UTF-8 XML. Images, video, audio, archives, OLE, and encrypted or unknown binaries are rejected with 415. Finder's `._*` and `.DS_Store` files are stored only when they are under 64 KB, so a macOS mount can write them.

A PDF must end with `%%EOF` and must not contain an archive, executable, or media signature, or `/EmbeddedFile`, `/JavaScript`, `/JS`, `/Launch`, or `/RichMedia`. Flate streams inside a PDF can still carry bytes that do not show those signatures in the clear. That is the remaining gap.

The disposable-domain check uses a vendored copy of [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) (`disposable_email_blocklist.conf`, CC0) plus a local denylist that includes `lomvic.com` (the temp-email demo). It is a **soft signal**: the list is incomplete and it can mis-label a real domain. A parent domain match counts, so `a.mailinator.com` and `email.lomvic.com` are rejected.

## Litmus

`src/shared/litmus-results.ts` holds a real run of litmus 0.13 (Ubuntu 0.13-5build2) against `wrangler dev` on 2026-10-23. The suites were invoked one at a time. `basic` was 16/16 with one warning (DELETE of a collection whose Request-URI included a fragment), `copymove` 13/13, `props` 30/30, and `locks` 41/41. The `http` suite was not run. Upstream skips it because `Expect: 100-continue` times out on local Workers. The page prints those counts and the note; it does not invent a suite that has no raw output.

## Mount

After verify, the page prints snippets for Finder, `net use`, rclone, and Obsidian. The username is the drive id. The password is shown once on that page and is not saved in the browser. There is no public URL for a file. `/demos/r2-drive*` on the shared host redirects to `https://r2-drive.tech-demos.theserverless.dev` with 308. The session cookie is `__Host-r2drive_session`.
