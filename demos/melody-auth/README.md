# Melody Auth

Live at [melody-auth.tech-demos.theserverless.dev](https://melody-auth.tech-demos.theserverless.dev/) after deploy. The hub path `308`s there.

A **pluggable OAuth 2.1-aligned OpenID Provider and relying party** on Cloudflare Workers + D1 + KV. Any app that already speaks OIDC/OAuth can use it as IdP. Melody can also broker Google / GitHub / Microsoft / generic OIDC logins and issue its own tokens.

Inspired by [ValueMelody/melody-auth](https://github.com/ValueMelody/melody-auth) (MIT). This is a hosted mini, not a fork, and it does not vendor that codebase.

- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)
- **Client SDK:** [sdk/](./sdk/) (discovery, PKCE, callback, refresh, JWKS verify, Hono-shaped `bearerAuth`)

## Feature matrix

| Spec | Status |
| --- | --- |
| OIDC Discovery + JWKS (`kid`, ES256) | Done |
| Authorization code + PKCE S256 | Done |
| Refresh rotation + reuse detection | Done |
| Confidential `client_secret_basic` / `post` / `private_key_jwt` | Done |
| Public clients | Done |
| Client credentials | Done |
| Device authorization (RFC 8628) + `/device` | Done |
| Token exchange (RFC 8693) | Done |
| RFC 9068 `at+jwt` access tokens | Done |
| Introspection (RFC 7662) / revocation (RFC 7009) | Done |
| Userinfo, RP-initiated logout / `end_session_endpoint` | Done |
| PAR (RFC 9126), `response_mode=form_post` | Done |
| `prompt` / `max_age` / `login_hint`, consent per client+scopes | Done |
| Resource indicators (RFC 8707) | Done. Admin create/PATCH stores up to 5 `https` resources; otherwise `aud` is the client id |
| Dynamic client registration (RFC 7591/7592), gated | Done |
| Key ring rotation + verify window | Done (cron; previous `kid` kept 24h) |
| Implicit / resource-owner password | **Rejected** — removed in OAuth 2.1 |
| Federation RP (Google / GitHub / Microsoft / generic OIDC) | Done when secrets are set |
| DPoP, JAR, CIBA, MFA | Out of scope |

## What this demonstrates

**Pattern.** You can run a standards-compliant OpenID Provider at the edge and plug it into anything that already speaks OAuth/OIDC.

**What you can try**

- Sample app: sign up, consent, PKCE, inspect tokens, refresh, sign out.
- [OAuth playground](./public/playground.html): auth code, client credentials, device code, introspect, revoke, and the rejected password grant.
- `/device` user-code page (TV/CLI flow).
- Admin: masked users, registered clients; `ADMIN_TOKEN` to create a client (secret shown once).

**What you could build**

- SSO for your own apps without a SaaS IdP.
- Broker Google/GitHub/Microsoft into *your* tokens.
- Point Auth.js, Grafana, oauth2-proxy, or Cloudflare Access at this issuer.

**Limits**

- Demo users, DCR clients, and machine clients expire after 24 hours (sample + machine kept). Cron `*/15`.
- Local password sign-up sets `email_verified=false`. Federation links **only** on a verified upstream email.
- Turnstile on human sign-in/sign-up and DCR. Rate limits: `7481` authorize POST, `7482` token, `7483` admin, `7484` userinfo/logout, `7485` authorize GET, `7486` register, `7487` device, `7488` introspect, `7489` revoke, `7490` federation, `7491` PAR, `7492` playground. `7480` is goodvibes `CONNECT_LIMIT`.
- No implicit or password grant (OAuth 2.1). Error copy on `/token` explains why.

## Plug it into X

Issuer: `https://melody-auth.tech-demos.theserverless.dev`

Register a client (playground DCR, admin + `ADMIN_TOKEN`, or `POST /register` with Turnstile). Redirect URIs are exact-match. Public clients must use PKCE S256. Confidential clients use `client_secret_post` by default.

### Auth.js / NextAuth

```ts
import NextAuth from "next-auth";

export const { handlers, auth } = NextAuth({
  providers: [
    {
      id: "melody",
      name: "Melody Auth",
      type: "oidc",
      issuer: "https://melody-auth.tech-demos.theserverless.dev",
      clientId: process.env.MELODY_CLIENT_ID!,
      clientSecret: process.env.MELODY_CLIENT_SECRET, // omit for public + PKCE
      checks: ["pkce", "state", "nonce"],
    },
  ],
});
```

### oauth2-proxy

```bash
oauth2-proxy \
  --provider=oidc \
  --oidc-issuer-url=https://melody-auth.tech-demos.theserverless.dev \
  --client-id=YOUR_CLIENT_ID \
  --client-secret=YOUR_CLIENT_SECRET \
  --redirect-url=https://app.example/oauth2/callback \
  --email-domain=* \
  --oidc-extra-audience=YOUR_CLIENT_ID
```

### Grafana

```ini
[auth.generic_oauth]
enabled = true
name = Melody Auth
client_id = YOUR_CLIENT_ID
client_secret = YOUR_CLIENT_SECRET
scopes = openid email profile offline_access
auth_url = https://melody-auth.tech-demos.theserverless.dev/authorize
token_url = https://melody-auth.tech-demos.theserverless.dev/token
api_url = https://melody-auth.tech-demos.theserverless.dev/userinfo
use_pkce = true
```

### Cloudflare Access (custom OIDC IdP)

In Zero Trust → Settings → Authentication → Add OpenID Connect:

- Issuer: `https://melody-auth.tech-demos.theserverless.dev`
- Auth URL: `…/authorize`
- Token URL: `…/token`
- JWKS URL: `…/.well-known/jwks.json`
- Client ID / secret from Melody admin or DCR. Redirect URI is the Access callback Cloudflare shows.

### Express / Hono (SDK)

```ts
import { discover, bearerAuth } from "../sdk/src/index.ts";

const oidc = await discover("https://melody-auth.tech-demos.theserverless.dev");
app.use("/api/*", bearerAuth({ issuer: oidc.issuer, audience: "YOUR_CLIENT_ID" }));
```

## Upstream provider setup (optional RP)

Sign-in buttons stay hidden until the matching vars/secrets exist.

| Provider | Vars | Secrets | Notes |
| --- | --- | --- | --- |
| Google | `GOOGLE_CLIENT_ID` | `GOOGLE_CLIENT_SECRET` | Redirect `https://melody-auth.tech-demos.theserverless.dev/fed/google/callback` |
| GitHub | `GITHUB_CLIENT_ID` | `GITHUB_CLIENT_SECRET` | Scopes `read:user user:email`. Only **verified** emails link. |
| Microsoft | `MICROSOFT_CLIENT_ID` | `MICROSOFT_CLIENT_SECRET` | Common tenant `/common`. Tokens often omit `email_verified`; a verified email is accepted when `xms_edov` is true. Otherwise linking fails closed. |
| Generic OIDC | `OIDC_ISSUER`, `OIDC_CLIENT_ID` | `OIDC_CLIENT_SECRET` | HTTPS discovery only. The document `issuer` must match `OIDC_ISSUER`. Requires a verified email. |

## Run locally

```bash
cd demos/melody-auth
cp .dev.vars.example .dev.vars
bun install
bun run dev:local
```

`bun run dev:local` listens on `http://127.0.0.1:8788`. `bun run smoke` expects that URL.

## Deploy

Resources already exist from PR #43 (D1 `e522863a-1932-4955-99d7-18a13014c631`, KV `24dc62b3e8d94d139a8c5d63fdca1a1b`, Turnstile site key `0x4AAAAAAFYQUTxFgredOxQl`). Apply the additive migration, then deploy:

```bash
cd demos/melody-auth
CI=1 bunx wrangler d1 migrations apply DB --remote
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
# optional
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put ADMIN_TOKEN
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put MACHINE_CLIENT_SECRET
```

### New secrets / vars

| Name | Required | Purpose |
| --- | --- | --- |
| `TURNSTILE_SECRET` / `AUTH_PRIVATE_JWK` | yes | Existing |
| `ADMIN_TOKEN` | no | Admin mutations + DCR bypass |
| `MACHINE_CLIENT_SECRET` | no | Seeds `melody-machine` for client-credentials demos |
| `GOOGLE_*` / `GITHUB_*` / `MICROSOFT_*` / `OIDC_*` | no | Federation RP, when configured |
| `AUTH_KEK` | no | 32-byte AES-GCM key (base64url or 64 hex chars) that wraps signing-key `d` in KV. Rotation no-ops until this is set. Not in `secrets.required`, so deploy is not blocked. `wrangler secret put AUTH_KEK`. Once `jwks:ring` exists, do not change `AUTH_KEK` without first deleting that KV key — a mismatch fails unwrap and isolates fall back to `AUTH_PRIVATE_JWK`. |

Migrations `0004_oidc_full.sql` and `0005_review_fixes.sql` are additive only (ALTER + new tables). Bookmark D1 Time Travel before applying them. Never drop data. Client secrets are SHA-256; user passwords stay PBKDF2. Dynamic registration does not grant `client_credentials` or token exchange unless the caller presents `ADMIN_TOKEN`. The SDK's code exchange is not RFC 8693 token exchange.

After deploy, redeploy `apps/hub` so the gallery card picks up the new copy.

## Layout

```
src/worker/   OP endpoints, D1, JWKS ring, federation, hosted pages
src/client/   sample app, playground, admin
sdk/          zero-dep client + bearerAuth
public/       Graphite & Ember pages
migrations/   additive D1
test/         grants, discovery, device binding, token exchange, DCR, key ring, PKCE, SDK
```
