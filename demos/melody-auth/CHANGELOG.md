# Changelog — melody-auth vs Melody Auth

This demo is a slice inspired by [ValueMelody/melody-auth](https://github.com/ValueMelody/melody-auth) (MIT). Upstream is a turnkey OAuth 2.0 / OIDC product on Workers + D1 + KV (and a Node.js target) with SDKs, an admin panel, MFA, social logins, and email. This repo is a **hosted mini** that shows the signup / password / OIDC slice on Workers Paid.

## Architecture

| | Melody Auth (upstream) | This demo |
| --- | --- | --- |
| Runtime | Worker + D1 + KV, or Node + Postgres + Redis | Worker + D1 + KV only |
| Grants | Authorization code, refresh, S2S, embedded auth | Authorization code + PKCE, refresh, client credentials, device, token exchange |
| Signing | RS256 JWKS, key rotation UI | ES256 key ring in KV (`kid`, cron rotate, verify window) |
| Identity | Password, passwordless, social, SAML, MFA | Email + password, plus optional Google/GitHub/Microsoft/OIDC |
| Admin | Full panel: users, apps, roles, orgs, logs | Masked users; client create/edit with ADMIN_TOKEN |
| Tenancy | Long-lived customer data | Demo users expire after 24 hours. Cron purge |
| Auth | Product accounts | Turnstile on sign-up and sign-in |
| UI | React / Vue / Angular SDKs | Graphite & Ember static sample app |

## What we cut

- MFA, passkeys, recovery codes
- SAML, DPoP, JAR, CIBA (federation presets are Google/GitHub/Microsoft + generic OIDC only)
- Email delivery, password reset
- RBAC, organizations, user attributes
- Workers for Platforms / dispatch namespaces

## What we kept (simplified)

- OIDC discovery and JWKS
- Hosted `/authorize` sign-up and sign-in
- Authorization-code + PKCE S256
- `/token`, `/userinfo`, `/logout`
- Refresh-token rotation (reuse kills the family)
- Exact `redirect_uri` match

## Branding

Hub Graphite & Ember. Background `#0e0e11`, ember `#c2410c`, Bricolage Grotesque and Hanken Grotesk. Contact links to https://theserverless.dev/contact.

## 2026-10-16

Full OP + RP: authorization code + PKCE, client credentials, device code (RFC 8628), token exchange (RFC 8693), RFC 9068 `at+jwt`, introspection, revocation, PAR, `form_post`, consent, DCR (RFC 7591/7592), JWKS key ring, admin client CRUD, federation RP (Google/GitHub/Microsoft/OIDC), playground, `sdk/` client. Implicit and password grants rejected (OAuth 2.1). Rate limits `7486`–`7492`.

Polish: refresh claim+child insert is one D1 batch; code reuse revokes only the stored family; JWKS prefers the secret; authorize GET uses `7485`.

Review pass: `email_verified` is false; claim-first codes and refresh rotation; Origin `null` and `sec-fetch-site: cross-site` rejected; sole issuer `melody-auth.tech-demos.theserverless.dev`; `__Host-ma_session` only on the subdomain; demo signing key `503`s outside local; prod seed drops loopback / hub / docs clients; authorize validates `response_type`, scopes, and state/nonce length; sample app checks nonce/aud/iss/exp.

Second review: token exchange and client-credentials are confined to the caller's grant, scopes, and `resources`; DCR strips privileged grants; device codes are client-bound; federation rotates an unverified local password and checks the ID token plus a state cookie; the key ring wraps `d` with `AUTH_KEK`, republishes on a 60s read, and stages the next `kid` for one JWKS cache period; `private_key_jwt` is single-use; ID tokens are not access tokens. Migration `0005_review_fixes.sql` is additive.

First slice: hosted authorize, sample-app PKCE client, token inspector, admin list, 24-hour cron purge, Turnstile, rate limits `7481` / `7482` / `7483` / `7484`. Phone layout uses 16px fields and 44px controls.
