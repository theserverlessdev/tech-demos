# Changelog — melody-auth vs Melody Auth

This demo is a slice inspired by [ValueMelody/melody-auth](https://github.com/ValueMelody/melody-auth) (MIT). Upstream is a turnkey OAuth 2.0 / OIDC product on Workers + D1 + KV (and a Node.js target) with SDKs, an admin panel, MFA, social logins, and email. This repo is a **hosted mini** that shows the signup / password / OIDC slice on Workers Paid.

## Architecture

| | Melody Auth (upstream) | This demo |
| --- | --- | --- |
| Runtime | Worker + D1 + KV, or Node + Postgres + Redis | Worker + D1 + KV only |
| Grants | Authorization code, refresh, S2S, embedded auth | Authorization code + PKCE S256, refresh rotation |
| Signing | RS256 JWKS, key rotation UI | ES256 via WebCrypto. Private JWK is a Worker secret. Public JWKS in KV |
| Identity | Password, passwordless, social, SAML, MFA | Email + password only |
| Admin | Full panel: users, apps, roles, orgs, logs | Read-only masked users and registered apps |
| Tenancy | Long-lived customer data | Demo users expire after 24 hours. Cron purge |
| Auth | Product accounts | Turnstile on sign-up and sign-in |
| UI | React / Vue / Angular SDKs | Graphite & Ember static sample app |

## What we cut

- MFA, passkeys, recovery codes
- Social, OIDC federation, and SAML
- Email delivery, password reset, email verification
- RBAC, organizations, user attributes
- Embedded Auth API and first-party SDKs
- Admin mutations and impersonation
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

First slice: hosted authorize, sample-app PKCE client, token inspector, admin list, 24-hour cron purge, Turnstile, rate limits `7471` / `7472` / `7473`. Phone layout uses 16px fields and 44px controls.
