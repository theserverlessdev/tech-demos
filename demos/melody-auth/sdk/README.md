# melody-auth client

Zero-dependency OIDC client for Workers, browsers, and Node. Discovery (issuer must match), PKCE, authorization-code exchange, refresh, ID-token checks (`nonce`, `azp`, non-empty audience), and JWKS verify. Access-token verify accepts `at+jwt` and `application/at+jwt` (any case), requires `token_use=access`, and requires an audience. An unknown `kid` refetches JWKS once per URI per 30s; the limit is set before the fetch and concurrent callers share one in-flight request. `bearerAuth` is Hono-shaped and does not turn downstream errors into 401s.

"Token exchange" in this SDK means exchanging an authorization code. RFC 8693 token exchange is a server grant and is not implemented here.

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
