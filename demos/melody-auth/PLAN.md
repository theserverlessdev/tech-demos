# Melody Auth — full OAuth 2.x / OIDC OP + RP

## Goal

Melody Auth is a **pluggable OAuth 2.1-aligned OpenID Provider and a relying party** on Workers + D1 + KV: any app that already speaks OIDC/OAuth can use it as IdP, and Melody can broker Google / GitHub / Microsoft / generic OIDC logins and issue its own tokens.

## MVP (this cut)

- Authorization code + PKCE S256, confidential clients (`client_secret_basic` / `post` / `private_key_jwt`), public clients.
- Grants: `authorization_code`, `refresh_token` (rotation + reuse), `client_credentials`, device code (RFC 8628), token exchange (RFC 8693). **No implicit, no password grant** (removed in OAuth 2.1).
- RFC 9068 JWT access tokens (`at+jwt`), ID tokens, introspection (7662), revocation (7009), userinfo, RP-initiated logout, PAR (9126), `response_mode=form_post`, `prompt` / `max_age` / `login_hint`, consent per client+scopes, `openid profile email offline_access` plus `api` + `resource` (RFC 8707).
- Dynamic client registration (7591/7592), gated by Turnstile or `ADMIN_TOKEN`, demo TTL.
- JWKS key ring with `kid`, cron rotation, previous key kept for verify.
- Admin: create/edit clients; secrets shown once; hashed at rest.
- Federation: Sign in with Google / GitHub / Microsoft / generic OIDC when secrets exist; link only on **verified** upstream email.
- Playground page (auth code, client credentials, device, introspect, revoke, refresh) with request/response viewer.
- Tiny zero-dep SDK under `sdk/` (discovery, PKCE, callback, refresh, JWKS verify, Workers/Hono guard).
- README “Plug it into X” snippets.

## Out of scope

MFA, SAML, CIBA, DPoP, JAR request objects, WebFinger, password grant, implicit, social beyond the three presets + generic OIDC, Workers for Platforms.

## Stack

- Workers + Static Assets + D1 (additive migrations) + KV (JWKS ring).
- Rate limits: keep 7481–7485; add unused **7486–7492**.
- Turnstile on human paths. No Hono in the Worker; SDK is optional Hono-shaped middleware.

## Tasks

1. Additive `0004_oidc_full.sql` + rate-limit bindings 7486–7492.
2. Client auth, grants, PAR, device, introspect/revoke, consent, RFC 9068 access JWTs, key ring.
3. Dynamic registration + admin mutations (hashed secrets).
4. Federation RP + SDK + playground + plug-in docs.
5. Tests per grant, typecheck, build, smoke, 390px artifacts.

## Deferred

DPoP, JAR, CIBA, password/implicit (never), multi-region key HSM.
