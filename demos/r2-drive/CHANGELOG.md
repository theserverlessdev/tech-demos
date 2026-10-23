# Changelog

Port of [abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav) (Apache-2.0, Copyright 2026 abersheeran). The WebDAV method behaviour is derived from that Worker. Persistence, tenancy, and abuse controls are new.

## Kept

- Class 1 methods: `OPTIONS`, `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL`, `PROPFIND`, `PROPPATCH`, `COPY`, `MOVE`.
- Class 2 `LOCK` and `UNLOCK`, including refresh, exclusive and shared scopes, and depth.
- Dead properties in R2 custom metadata, with an 1800-byte cap (507 when it would overflow).
- `@xmldom/xmldom` for the request bodies.

## Changed

- One R2 bucket, many drives. Every object lives under `drives/<id>/`. A prefix wrapper rejects keys that escape it.
- Locks live in a SQLite Durable Object per drive, not in R2 metadata.
- Credentials are per visitor. Basic auth is PBKDF2-SHA256 at rest and compared in constant time. A session cookie is the browser credential. Both die with the drive.
- No shared `USERNAME` / `PASSWORD`. No HTML directory listing. An authenticated collection `GET` is a plain-text name list.
- No CORS. Responses send `Cache-Control: private, no-store`. There is no anonymous read and no share link.
- `creationdate` is ISO 8601. `getlastmodified` stays RFC 1123. `MS-Author-Via: DAV` is set for Explorer.
- `COPY` and `MOVE` run sequentially. `Destination` must be the same origin and the same drive mount.
- `PUT` replaces the client `Content-Type` with the sniffed type. Office downloads are attachments. Text, JSON, and PDF are inline.
- Quotas: 5 MB per file, 25 MB per drive, 200 objects, 1 hour TTL.
- Content allow-list by magic bytes (`src/shared/content-policy.ts`).
- Minting requires Turnstile, an accepted use notice, and a magic link from Cloudflare Email Sending. One live drive per normalised email.
- D1 keeps an audit row (HMAC email, encrypted email, IP hash, network hash, object key, sha256, size) for 30 days after the wipe.
- Admin token can freeze a drive or disable minting. `MINT_ENABLED` is off unless the env value is the string `true`.
- The litmus page starts empty. It shows a suite only after a real `litmus` run is recorded with its raw output.
