# Plan — hub security and quality audit

## Goal

Close the Opus audit of `apps/hub` at `192a789`, plus the two live cross-demo issues in hello-dynamic and temp-email / edgechat. No deploy, no new repo, no Cloudflare dashboard changes.

## MVP

- Blockers B1–B2 (reflected XSS, Dynamic Worker CSP, edgechat file serving).
- Should-fix S1–S9 (open redirect helper, standalone 503, loader id hash, header strip, 390px header, gallery copy, README).
- Nits listed in the audit.
- Tests for the pure helpers and a 390px gallery screenshot.

## Out of scope

- Wrangler deploy, Workers Builds, new GitHub repos, Cloudflare route/DNS edits.

## Tasks

1. `redirectSource(slug, origin)` + `safeRedirectTarget` in `@tech-demos/shared`; use them in the hub registry and temp-email.
2. Load hello-dynamic `worker.js` as a Text module; HTML-escape and cap `?name=`; wrap every Dynamic Worker response with sandbox CSP + nosniff.
3. Loader id = hash(source + compatibilityDate); strip Cookie and Authorization before forwarding.
4. `kind: "loader" | "standalone"`; subdomain hits for standalone demos return 503.
5. Edgechat `/api/files/*`: inline only png/jpeg/gif/webp; otherwise attachment + octet-stream; CSP sandbox on every file response.
6. Gallery: 390px header, scroll-margin, hero runtime line, registry copy/tags, README two-path architecture.
7. Nits: real 404, generic 502, cache/CORS/security headers, menu dismiss, footer 44px.

## Stack

- Existing hub Worker + Dynamic Worker Loader (Paid plan).
- Bun tests for helpers (no wrangler miniflare harness required for the security logic).

## Deferred

- Deploy. Cloudflare dashboard. Per-demo Workers Builds.
