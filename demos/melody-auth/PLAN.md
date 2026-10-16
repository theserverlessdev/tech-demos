# Melody Auth

## Goal

Prove that you can run your own standards-compliant sign-in server at the edge on Workers + D1 + KV: OAuth 2.0 authorization code + PKCE S256, OIDC discovery / JWKS / ID tokens, hosted sign-up and sign-in, refresh rotation, and a sample app that inspects the tokens.

This is a **fresh small slice** inspired by [ValueMelody/melody-auth](https://github.com/ValueMelody/melody-auth) (MIT). It is not a fork and it does not vendor that codebase.

## MVP

One Worker + Static Assets. A visitor opens the sample app, signs up or signs in on the hosted `/authorize` page (Turnstile), completes the PKCE code flow, reads decoded ID token claims and `/userinfo`, refreshes, and signs out. A tiny admin page lists masked demo users and registered apps. A cron deletes users older than 24 hours.

## Out of scope

MFA, social logins, email delivery, password reset, SAML, RBAC, organizations, admin mutations, Workers for Platforms, Containers.

## Stack

- **Workers + Static Assets** — sample app, admin, and the auth API share one Worker (`run_worker_first`).
- **D1** — users, apps (clients + exact redirect URIs), auth codes, hosted sessions, refresh tokens.
- **KV** — JWKS / signing-key metadata (`kid`, public JWK). Private key is `AUTH_PRIVATE_JWK` (ES256 via WebCrypto).
- **Turnstile** — sign-up and sign-in. Site key var `TURNSTILE_SITE_KEY` (placeholder / widget key). Secret `TURNSTILE_SECRET`.
- **Rate-limit bindings** — `7481` authorize (POST), `7482` token, `7483` admin, `7484` userinfo/logout. Unused elsewhere (`7480` is goodvibes `CONNECT_LIMIT`).
- **No Hono, no React, no jose.** Vanilla TS, Bun bundle, Graphite & Ember.

## Tasks

1. D1 schema + seed sample app + 24h cron purge.
2. ES256 JWT / JWKS (secret private JWK, public JWKS in KV).
3. OIDC endpoints: discovery, JWKS, authorize (hosted pages), token (code + PKCE S256, refresh rotation), userinfo, logout.
4. Sample app PKCE client and admin list (masked emails, no destructive actions).
5. Turnstile, exact `redirect_uri`, generic errors, secure cookies, CSP.
6. Unit tests, typecheck, build, 390px screenshots + short video.
7. Hub registry fallback via `redirectSource`.

## Architecture

```text
browser ── HTTPS ──► Worker
                      ├─ Static Assets (sample app, admin)
                      ├─ Hosted /authorize (sign-up / sign-in)
                      ├─ D1 users, apps, codes, sessions, refresh
                      └─ KV JWKS metadata  +  AUTH_PRIVATE_JWK secret
```

Worker `tech-demos-melody-auth`:

- `tech-demos.theserverless.dev/demos/melody-auth*`
- `melody-auth.tech-demos.theserverless.dev/*`

## Testing

- `bun test` — PKCE S256, exact `redirect_uri`, code reuse, refresh rotation, PBKDF2 verify.
- `bun run typecheck` and `bun run build`.
- `scripts/smoke.ts` against `wrangler dev` for the full code flow.

## Deferred

MFA, social, email, password reset, ES256 rotation UI, multi-tenant orgs.
