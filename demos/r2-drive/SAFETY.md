# Safety

This demo is a short-lived sandbox for testing WebDAV with small documents. Only text, PDF and office documents are accepted. Drives are private and wiped within an hour. Misuse can be reported, and drives can be frozen. The controls below are the design, not an add-on.

## Private drives

- There is no share link, public object URL, or presigned URL. The UI does not generate one.
- A file is readable only with that drive's own short-lived credential: the Basic password, or the `__Host-r2drive_session` cookie. The password is shown once on the page and is not stored in the browser.
- `OPTIONS` and every `/dav` method require that credential. An anonymous request gets 401 and no body bytes.
- CORS is not enabled. `Access-Control-Allow-Origin` is stripped if something else set it.
- Every response sends `Cache-Control: private, no-store`, plus `nosniff` and `no-referrer`.
- The TTL is one hour. It is enforced when the drive is touched, by the Durable Object alarm, and by a cron every five minutes.
- `lifecycle.json` is the R2 backstop: delete `drives/` after one day (`maxAge` 86400). R2 lifecycle is day-scale, so it cannot promise a one-hour delete. Unreadable leftover bytes can sit until that rule runs.
- Caps, in `src/shared/constants.ts`: 5 MB per file, 25 MB per drive, 200 objects. Quota changes are one SQLite `UPDATE … WHERE bytes + ? <= cap RETURNING` on the Durable Object, and mutating methods run one at a time per drive. A failed copy leaves the counter equal to the bytes still stored. Keys over 900 bytes get 414.

## Allow-list

`src/shared/content-policy.ts` exports one `CONTENT_RULES` list. `PUT` walks it from top to bottom and stops at the first match. The file extension and the client `Content-Type` are ignored.

Allowed: UTF-8 text (Markdown, CSV, notes), JSON, PDF, and OOXML Word / Excel / PowerPoint. An office package is allowed only when every part name ends in `.xml` or `.rels`, each part inflates under 1 MB, and the inflated bytes are UTF-8 XML. OLE is not accepted.

Rejected with 415: images, video, audio, zip, 7z, rar, tar, gz, OLE, and the other archive and executable signatures in that list, plus PGP and age armour anywhere in a text file, OpenSSL `Salted__`, a long base64 or hex run, and anything else that is not valid text.

PDF must include a `%%EOF` trailer in the last 1024 bytes. Archive, executable, and media signatures are rejected anywhere in the body, as are `/EmbeddedFile`, `/JavaScript`, `/JS`, `/Launch`, and `/RichMedia`. PDFs are served as attachments with `Content-Security-Policy: default-src 'none'; sandbox`.

What remains: a Flate stream inside an otherwise ordinary PDF can still carry bytes that do not show those signatures in the clear. Short encoded fragments under the run length can pass as text. The cap, the missing share link, and the one-hour TTL bound that residual. Empty files and `MKCOL` collections skip the sniff. `._*` and `.DS_Store` are accepted only under 64 KB so Finder can write them.

## Minting

- Turnstile, then a magic link through the Email Sending binding `EMAIL`.
- The visitor must submit `aup: true`. The same notice is on the form.
- Addresses are normalised: lowercase, strip `+` tags, fold `googlemail.com` to `gmail.com`, strip dots on gmail.
- One non-wiped drive per normalised email. An expired row is wiped before a new mint.
- Rate limits: email, client network, and a global per-minute cap. The network key is an IPv6 /64 or an IPv4 /24. IPv4 has no /64. WebDAV also has a per-drive limiter (namespace 7613, keyed by drive id) and a global DAV ceiling (namespace 7607).
- `DAILY_EMAIL_CAP` counts messages sent. `DAILY_MINT_CAP` counts drives created at verify time, so an unverified request does not spend a drive.
- Disposable domains are rejected before mail is sent. The list is vendored from [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) (CC0), plus a local denylist that includes `lomvic.com`. Matching walks parent domains. It is a **soft signal**. It is incomplete and it can be wrong. See the README.

`MINT_ENABLED` must be the string `"true"`. Any other value, including unset, leaves minting off. `wrangler.jsonc` sets `"false"`. Local dev passes `--var MINT_ENABLED:true`. `POST /api/admin/mint` with `{"enabled": false}` sets a D1 kill flag. The admin route cannot turn minting on when the env value is not `"true"`. Missing audit keys return 503. They are not replaced with an all-zero key.

## Records

Each drive row in D1 stores:

- `email_hmac`: HMAC-SHA256 of the normalised address under `AUDIT_HMAC_KEY`
- `email_enc`: AES-GCM of the address under `AUDIT_KEY`, so the address can be recovered for a report
- `ip_hmac`: HMAC of the rate-limit IP (IPv6 /64, full IPv4)
- `network_hmac`: HMAC of the block key (IPv6 /64, IPv4 /24)
- creation time, expiry, status
- one `objects` row per stored body: full key, sha256, size, first-seen time

The IP itself is not stored. The address is recoverable only with `AUDIT_KEY`, via `POST /api/admin/audit`. Rows are deleted 30 days after the wipe. Block rows are not auto-purged.

`POST /api/report` (Turnstile, 10–2000 character reason) records the report. If the drive id exists and is not already wiped, the drive is frozen and its email and network are blocked. The reporter's address is not blocked. The response is 202 either way.

A frozen drive is kept for evidence. The hour wipe skips it, and a new mint for that email stays blocked. `POST /api/admin/release` wipes it. If nobody releases it, the cron wipes it 30 days after `frozen_at`. The one-day R2 lifecycle can still delete the bytes before that; the D1 row (keys, hashes, sizes, encrypted email) is the record that lasts.

`Authorization: Bearer $ADMIN_TOKEN` (the token is hashed before compare):

- `POST /api/admin/mint` `{"enabled": false}` disables minting
- `POST /api/admin/freeze` `{"driveId": "drv_…"}` freezes one drive
- `POST /api/admin/release` `{"driveId": "drv_…"}` wipes a frozen drive
- `POST /api/admin/block` and `/api/admin/unblock` take `email` and/or `ip`
- `POST /api/admin/audit` returns the decrypted email and the object list

A frozen or blocked drive gets 403 on WebDAV. A wiped drive gets 401. Writes after `expiresAt` get 410 from the Durable Object. The request path wipes an active drive that has already expired and then returns 401.
