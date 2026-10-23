# Safety

This demo is a short-lived sandbox for testing WebDAV with small documents. Only text, PDF and office documents are accepted. Drives are private and wiped within an hour. Misuse can be reported, and drives can be frozen. The controls below are the design, not an add-on.

## Private drives

- There is no share link, public object URL, or presigned URL. The UI does not generate one.
- A file is readable only with that drive's own short-lived credential: the Basic password, or the `HttpOnly` session cookie.
- `OPTIONS` and every `/dav` method require that credential. An anonymous request gets 401 and no body bytes.
- CORS is not enabled. `Access-Control-Allow-Origin` is stripped if something else set it.
- Every response sends `Cache-Control: private, no-store`, plus `nosniff` and `no-referrer`.
- The TTL is one hour. It is enforced when the drive is touched, by the Durable Object alarm, and by a cron every five minutes.
- `lifecycle.json` is the R2 backstop: delete `drives/` after one day (`maxAge` 86400). R2 lifecycle is day-scale, so it cannot promise a one-hour delete. Unreadable leftover bytes can sit until that rule runs.
- Caps, in `src/shared/constants.ts`: 5 MB per file, 25 MB per drive, 200 objects.

## Allow-list

`src/shared/content-policy.ts` exports one `CONTENT_RULES` list. `PUT` walks it from top to bottom and stops at the first match. The file extension and the client `Content-Type` are ignored.

Allowed: UTF-8 text (Markdown, CSV, notes), JSON, PDF (`%PDF-`), OOXML Word / Excel / PowerPoint with no media parts, and OLE compound documents that do not contain an embedded image signature.

Rejected with 415: images, video, audio, zip, 7z, rar, tar, gz, and the other archive and executable signatures in that list, plus PGP, age, and OpenSSL `Salted__` payloads, plus anything else that is not valid text.

A PDF can still embed an image. The cap, the missing share link, and the one-hour TTL are what limit that residual. Office packages that contain a `media/` part or an image extension are rejected. Empty files and `MKCOL` collections skip the sniff.

## Minting

- Turnstile, then a magic link through the Email Sending binding `EMAIL`.
- The visitor must submit `aup: true`. The same notice is on the form.
- Addresses are normalised: lowercase, strip `+` tags, fold `googlemail.com` to `gmail.com`, strip dots on gmail.
- One non-wiped drive per normalised email. An expired row is wiped before a new mint.
- Rate limits: email, client network, and a global per-minute cap. The network key is an IPv6 /64 or an IPv4 /24. IPv4 has no /64. A separate D1 counter caps mints per UTC day (`DAILY_MINT_CAP`).
- Disposable domains are rejected before mail is sent. The list is vendored from [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) (CC0) and is a **soft signal**. It is incomplete and can be wrong. See the README.

`MINT_ENABLED` must be the string `"true"`. Any other value, including unset, leaves minting off. The deploy config sets `"true"`. `POST /api/admin/mint` with `{"enabled": false}` sets a D1 kill flag. The admin route cannot turn minting on when the env value is not `"true"`.

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

`Authorization: Bearer $ADMIN_TOKEN` (the token is hashed before compare):

- `POST /api/admin/mint` `{"enabled": false}` disables minting
- `POST /api/admin/freeze` `{"driveId": "drv_…"}` freezes one drive
- `POST /api/admin/block` and `/api/admin/unblock` take `email` and/or `ip`
- `POST /api/admin/audit` returns the decrypted email and the object list

A frozen or blocked drive gets 403 on WebDAV. A wiped drive gets 401.
