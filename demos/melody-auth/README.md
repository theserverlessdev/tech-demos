# Melody Auth

Live at [melody-auth.tech-demos.theserverless.dev](https://melody-auth.tech-demos.theserverless.dev/) after deploy. The hub path `308`s there.

A standards-compliant OAuth 2.0 / OIDC sign-in server on Cloudflare Workers + D1 + KV. The sample app runs the full PKCE flow: sign up, sign in, inspect tokens, refresh, sign out.

Inspired by [ValueMelody/melody-auth](https://github.com/ValueMelody/melody-auth) (MIT). This is a hosted mini, not a fork, and it does not vendor that codebase.

- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

## What this demonstrates

**Pattern.** You can run your own standards-compliant sign-in server at the edge on Workers + D1 + KV. Hosted sign-up and sign-in, authorization codes with PKCE S256, ES256 JWKS, and refresh-token rotation — without a SaaS IdP.

**What you can try**

- Sign up and sign in on the hosted authorize page.
- Complete the PKCE authorization-code flow in the sample app.
- Inspect decoded ID token claims and the `/userinfo` result.
- Refresh the access token (rotation) and sign out.
- Open the admin list of masked demo users and registered apps.

**What you could build**

- SSO for your own apps on Workers.
- Auth for a side project without a SaaS IdP.
- A standards-compliant login box you host at the edge.

**Limits**

- Signup / password / OIDC only. No MFA, no social logins, no email delivery. Emails are not verified (`email_verified` is always `false`).
- Demo users expire after 24 hours. A cron every 15 minutes deletes them and their codes, sessions, and refresh tokens.
- Sign-up and sign-in require Turnstile. Rate limits are authorize `7481` (8/min, POST only), token `7482` (20/min), admin `7483` (60/min), and userinfo/logout `7484` (30/min). `7480` is goodvibes `CONNECT_LIMIT`.
- `redirect_uri` is an exact string match. Codes are 60 seconds and single-use (claim-first). A reused refresh token revokes its family.
- Error copy is generic. A missing user and a wrong password both return “Email or password is incorrect.”
- Sign-up hashes with PBKDF2 before the existence check. A unique-email constraint and insert-vs-conflict timing can still leak whether an address is already registered.

## What is real

- D1 tables for users, apps, auth codes, hosted sessions, and refresh tokens.
- KV holds the public JWKS document (`jwks:current`). `/.well-known/jwks.json` is served from that KV value. The ES256 private JWK is `AUTH_PRIVATE_JWK` (a Worker secret). Production rejects the committed demo key.
- `/.well-known/openid-configuration`, `/.well-known/jwks.json`, `/authorize`, `/token`, `/userinfo`, `/logout`.
- Passwords are PBKDF2-SHA-256 (100k iterations) with a per-user salt, via WebCrypto.
- Admin is read-only. Emails are masked. There are no delete or edit actions.

## Run locally

```bash
cd demos/melody-auth
cp .dev.vars.example .dev.vars
bun install
bun run dev:local
```

`.dev.vars` uses Cloudflare's [always-pass Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/). `ENVIRONMENT=local` is required because `wrangler dev` rewrites Host to the first production route. The widget token for those keys is `XXXX.DUMMY.TOKEN.XXXX`.

`bun run dev:local` listens on `http://127.0.0.1:8788`. `bun run smoke` expects that URL.

`bun run typecheck` runs `wrangler types` before `tsc`. `bun test` covers PKCE, `redirect_uri`, code reuse, refresh rotation, and password hashing.

## Deploy

Do not deploy from this PR until the resources below exist. From this folder, with the owner account (unset any other API token):

```bash
bunx wrangler d1 create tech-demos-melody-auth
# paste the database_id over the placeholder in wrangler.jsonc
bunx wrangler kv namespace create tech-demos-melody-auth-keys
# paste the id over the placeholder in wrangler.jsonc
CI=1 bunx wrangler d1 migrations apply DB --remote
# TURNSTILE_SITE_KEY in wrangler.jsonc is REPLACE_ME_MINT_A_DEDICATED_WIDGET. Mint a dedicated widget, then paste the site key.
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put TURNSTILE_SECRET
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put AUTH_PRIVATE_JWK
```

Generate `AUTH_PRIVATE_JWK` as an ES256 (P-256) JWK with `kid`, `d`, `x`, and `y`. A brand-new Worker with `secrets.required` needs a first deploy before `wrangler secret put` works. Run both secret commands after the first deploy, then deploy once more.

### Deploy checklist

| Resource | Name | Status |
| --- | --- | --- |
| D1 database | `tech-demos-melody-auth` | **Create.** `wrangler d1 create tech-demos-melody-auth`, then paste `database_id` over `00000000-0000-4000-8000-000000007471` in `wrangler.jsonc`. Apply `migrations/0001_init.sql`. |
| KV namespace | `tech-demos-melody-auth-keys` | **Create.** `wrangler kv namespace create tech-demos-melody-auth-keys`, then paste `id` over `00000000000000000000000000007471`. |
| Secret | `TURNSTILE_SECRET` | **Create.** `wrangler secret put TURNSTILE_SECRET`. Do not commit it. |
| Secret | `AUTH_PRIVATE_JWK` | **Create.** ES256 private JWK JSON. Public JWKS is derived and stored in KV. |
| Turnstile widget | `tech-demos-melody-auth` | **Create.** Mint a dedicated widget for `melody-auth.tech-demos.theserverless.dev`. Site key var is `TURNSTILE_SITE_KEY` (placeholder `REPLACE_ME_MINT_A_DEDICATED_WIDGET`). Action `melody-auth`. |
| Rate-limit namespaces | `7481` authorize, `7482` token, `7483` admin, `7484` userinfo/logout | Created on deploy. Unused elsewhere in this repo (`7480` is goodvibes `CONNECT_LIMIT`). |
| Cron | `*/15 * * * *` | Applied on deploy. Deletes users with `expires_at` in the past (24 hours after creation) and their codes, sessions, and refresh tokens. |
| Routes | `tech-demos.theserverless.dev/demos/melody-auth*` and `melody-auth.tech-demos.theserverless.dev/*` | Applied on deploy. The zone is `theserverless.dev`. |

Production fails closed when `TURNSTILE_SECRET` or `AUTH_PRIVATE_JWK` is missing, and it rejects the always-pass test secret unless `ENVIRONMENT` is `local`.

The issuer is only `https://melody-auth.tech-demos.theserverless.dev`. Requests on the hub path `308` to that origin. After the Worker is deployed, redeploy `apps/hub` so the gallery card is not only the fallback.

## Layout

```
src/worker/   OIDC endpoints, D1, JWKS, Turnstile, hosted pages
src/client/   sample app PKCE client, admin list
public/       Graphite & Ember pages
migrations/   users, apps, codes, sessions, refresh
test/         PKCE, redirect_uri, codes, refresh, passwords
```
