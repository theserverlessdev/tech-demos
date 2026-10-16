# melody-auth client

Zero-dependency OIDC client for Workers, browsers, and Node. Discovery, PKCE, token exchange, refresh, JWKS verify with a 5-minute cache, plus a Hono-shaped `bearerAuth` middleware.

```ts
import { discover, createPkce, authorizationUrl, exchangeCode, verifyAccessToken, bearerAuth } from "./src/index.ts";

const oidc = await discover("https://melody-auth.tech-demos.theserverless.dev");
const pkce = await createPkce();
const url = authorizationUrl(oidc, {
  clientId: "melody-sample",
  redirectUri: "https://app.example/callback",
  state,
  nonce,
  challenge: pkce.challenge,
});
```

Protect a Hono API:

```ts
app.use("/api/*", bearerAuth({ issuer: oidc.issuer, audience: "https://api.example" }));
```
