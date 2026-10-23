# Changelog

Port of [abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav) (Apache-2.0, Copyright 2026 abersheeran). The WebDAV method behaviour is derived from that Worker. Persistence, tenancy, and the private-drive limits are new.

## Kept

- Class 1 methods: `OPTIONS`, `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL`, `PROPFIND`, `PROPPATCH`, `COPY`, `MOVE`.
- Class 2 `LOCK` and `UNLOCK`, including refresh, exclusive and shared scopes, and depth.
- Dead properties in R2 custom metadata, with an 1800-byte cap (507 when it would overflow).
- `@xmldom/xmldom` for the request bodies. The port uses 0.9.12 rather than upstream's 0.8.11, which is deprecated for security issues.

## Changed

- One R2 bucket, many drives. Every object lives under `drives/<id>/`. A prefix wrapper rejects keys that escape it.
- Locks live in a SQLite Durable Object per drive, not in R2 metadata.
- Credentials are per visitor. Basic auth is PBKDF2-SHA256 at rest and compared in constant time. A session cookie is the browser credential. Both die with the drive.
- No shared `USERNAME` / `PASSWORD`. No HTML directory listing. An authenticated collection `GET` is a plain-text name list.
- No CORS. Responses send `Cache-Control: private, no-store`. There is no anonymous read and no share link.
- `creationdate` is ISO 8601. `getlastmodified` stays RFC 1123. `MS-Author-Via: DAV` is set for Explorer.
- `COPY` and `MOVE` run sequentially. `Destination` must be the same origin and the same drive mount.
- `PUT` replaces the client `Content-Type` with the sniffed type. PDF downloads are attachments. Text and JSON are inline. Office files are not accepted.
- Quotas: 5 MB per file, 25 MB per drive, 200 objects, 1 hour TTL. The counter is an atomic SQLite update on the Durable Object, and writes for one drive run one at a time.
- Content allow-list by magic bytes (`src/shared/content-policy.ts`).
- Minting requires Turnstile, an accepted use notice, and a magic link from Cloudflare Email Sending. One live drive per normalised email.
- D1 keeps an audit row (HMAC email, encrypted email, IP hash, network hash, object key, sha256, size) for 30 days after the wipe.
- Admin token can freeze a drive or disable minting. `MINT_ENABLED` is off unless the env value is the string `true`. Production Turnstile uses the shared widget site key `0x4AAAAAAFRUoj5qDpf7XyIW`. Local dev keeps the test site key.
- The litmus page shows a suite only when `src/shared/litmus-results.ts` contains that suite's raw output. A 2026-10-23 run, one suite at a time after COPY and MOVE started charging one unit per file written, records `basic` 16/16 at 18:56:19Z, `copymove` 13/13 at 18:57:29Z, `props` 30/30 at 18:58:42Z, `locks` 41/41 at 18:59:52Z, and `http` 4/4 at 19:01:04Z. Each suite has its own start time.
- Word, Excel, PowerPoint, and other ZIP-based files are rejected. Finder `._*` and `.DS_Store` files must match their magic bytes and can still hold 64 KB of opaque binary. PDF names are checked after `#xx` escapes. A compressed or image stream inside a PDF can still carry pictures and arbitrary bytes.
- A drive holds at most 64 locks and 8 shared locks on one path. The owner is at most 1 KB, and each token is one row. The live log allows 4 sockets, closes a client message, and closes the peer socket from `webSocketClose`. Each drive also stops after 3000 units: one per WebDAV request or live-log connection. A COPY or MOVE costs one unit per file or folder it writes, with a minimum of one.
- A frozen drive stays until an admin release or 30 days. An admin freeze moves the alarm. A report freeze takes effect when the alarm fires, and a later report does not move `frozen_at`. DAV ceilings are 240 per drive and 600 per Cloudflare location per minute. The email cap counts a message only after it is sent.
- `LICENSE` line 1 matches upstream `abersheeran/r2-webdav` (`Copyright 2026 abersheeran`).

The quota, content checks, and hosting notes in `SAFETY.md` describe the current behaviour, including the PDF Flate-stream gap and the 30-day freeze retention.
