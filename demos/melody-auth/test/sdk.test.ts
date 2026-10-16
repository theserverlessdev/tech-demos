import { expect, test } from "bun:test";
import { importSigningKey, publicJwkFromPrivate, signJwt, generateEs256 } from "../src/worker/jwt";
import { OauthClientError, bearerAuth, completeAuthorizationCode, jwksKeys, protect, randomToken, resetJwksCacheForTests, verifyAccessToken, verifyIdToken, verifyJwt, discover } from "../sdk/src/index";

const issuer = "https://melody-auth.example";

test("the SDK rejects an ID token presented as an access token", async () => {
  resetJwksCacheForTests();
  const jwk = await generateEs256("sdk-1");
  const key = await importSigningKey(jwk);
  const pub = publicJwkFromPrivate(jwk);
  const now = Math.floor(Date.now() / 1000);
  const access = await signJwt(
    { alg: "ES256", typ: "at+jwt", kid: jwk.kid },
    { iss: issuer, sub: "usr_1", aud: "api", iat: now, exp: now + 60, token_use: "access", client_id: "melody-sample" },
    key,
  );
  const id = await signJwt(
    { alg: "ES256", typ: "JWT", kid: jwk.kid },
    { iss: issuer, sub: "usr_1", aud: "melody-sample", iat: now, exp: now + 60, token_use: "id", nonce: "n", azp: "melody-sample" },
    key,
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [pub] });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ issuer: "https://evil.example", authorization_endpoint: "https://evil.example/a", token_endpoint: "https://evil.example/t", jwks_uri: "https://evil.example/jwks" });
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  try {
    await expect(discover(issuer)).rejects.toBeInstanceOf(OauthClientError);
    await expect(verifyAccessToken(id, { issuer, jwksUri: `${issuer}/.well-known/jwks.json`, audience: "melody-sample" })).rejects.toThrow("typ");
    const claims = await verifyAccessToken(access, { issuer, jwksUri: `${issuer}/.well-known/jwks.json`, audience: "api" });
    expect(claims.token_use).toBe("access");
    const idClaims = await verifyIdToken(id, { issuer, jwksUri: `${issuer}/.well-known/jwks.json`, audience: "melody-sample", nonce: "n", azp: "melody-sample" });
    expect(idClaims.nonce).toBe("n");
    await expect(verifyJwt(access, [pub], { issuer, audience: "api", access: true }, now - 30)).resolves.toBeTruthy();
    await expect(verifyJwt(access, [pub], { issuer, audience: "api", access: true }, now + 120)).rejects.toThrow("exp");
    const early = await signJwt(
      { alg: "ES256", typ: "at+jwt", kid: jwk.kid },
      { iss: issuer, sub: "usr_1", aud: "api", iat: now + 30, nbf: now + 30, exp: now + 90, token_use: "access" },
      key,
    );
    await expect(verifyJwt(early, [pub], { issuer, audience: "api", access: true }, now)).resolves.toBeTruthy();
    const check = protect({ issuer, audience: "api" });
    try {
      await check(new Request(issuer, { headers: { authorization: `Bearer ${id}` } }));
      throw new Error("expected 401");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(401);
      expect((err as Response).headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    expect(randomToken(16).length).toBeGreaterThan(10);
  } finally {
    globalThis.fetch = original;
    resetJwksCacheForTests();
  }
});

test("an unknown kid triggers one JWKS refetch", async () => {
  resetJwksCacheForTests();
  const jwk = await generateEs256("sdk-2");
  const key = await importSigningKey(jwk);
  const pub = publicJwkFromPrivate(jwk);
  const now = Math.floor(Date.now() / 1000);
  const access = await signJwt(
    { alg: "ES256", typ: "at+jwt", kid: jwk.kid },
    { iss: issuer, sub: "usr_1", aud: "api", iat: now, exp: now + 60, token_use: "access" },
    key,
  );
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) return Response.json({ keys: [{ ...pub, kid: "other" }] });
    return Response.json({ keys: [pub] });
  }) as typeof fetch;
  try {
    const claims = await verifyAccessToken(access, { issuer, jwksUri: `${issuer}/.well-known/jwks.json`, audience: "api" });
    expect(claims.sub).toBe("usr_1");
    expect(calls).toBe(2);
    const stranger = await signJwt(
      { alg: "ES256", typ: "at+jwt", kid: "forged" },
      { iss: issuer, sub: "usr_1", aud: "api", iat: now, exp: now + 60, token_use: "access" },
      key,
    );
    await expect(verifyAccessToken(stranger, { issuer, jwksUri: `${issuer}/.well-known/jwks.json`, audience: "api" })).rejects.toThrow();
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = original;
    resetJwksCacheForTests();
  }
});

test("JWKS force refetch is per URI, stamped before fetch, and shared in flight", async () => {
  resetJwksCacheForTests();
  const jwk = await generateEs256("sdk-3");
  const pub = publicJwkFromPrivate(jwk);
  const uri = `${issuer}/jwks-a`;
  const other = `${issuer}/jwks-b`;
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1;
    const url = String(input);
    if (url === uri && calls === 1) {
      await gate;
      return Response.json({ keys: [pub] });
    }
    return new Response("no", { status: 500 });
  }) as typeof fetch;
  try {
    const pending = Promise.all([jwksKeys(uri, 10_000, true), jwksKeys(uri, 10_000, true)]);
    release?.();
    const [first, second] = await pending;
    expect(first).toEqual(second);
    expect(calls).toBe(1);
    await expect(jwksKeys(uri, 10_500, true)).resolves.toEqual(first);
    expect(calls).toBe(1);
    await expect(jwksKeys(other, 20_000, true)).rejects.toThrow("jwks");
    await expect(jwksKeys(other, 20_100, true)).rejects.toThrow("jwks");
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = original;
    resetJwksCacheForTests();
  }
});

test("verifyIdToken requires an audience, retries an unknown kid, and bearerAuth leaves route errors alone", async () => {
  resetJwksCacheForTests();
  const jwk = await generateEs256("sdk-4");
  const key = await importSigningKey(jwk);
  const pub = publicJwkFromPrivate(jwk);
  const now = Math.floor(Date.now() / 1000);
  const id = await signJwt(
    { alg: "ES256", typ: "JWT", kid: jwk.kid },
    { iss: issuer, sub: "usr_1", aud: "melody-sample", iat: now, exp: now + 60, token_use: "id", nonce: "n", azp: "melody-sample" },
    key,
  );
  const access = await signJwt(
    { alg: "ES256", typ: "application/at+jwt", kid: jwk.kid },
    { iss: issuer, sub: "usr_1", aud: "api", iat: now, exp: now + 60, token_use: "access" },
    key,
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/token")) return Response.json({ access_token: "only-access" });
    return Response.json({ keys: [pub] });
  }) as typeof fetch;
  try {
    await expect(verifyIdToken(id, { issuer, jwksUri: `${issuer}/jwks.json`, audience: "" })).rejects.toThrow("aud_required");
    const claims = await verifyAccessToken(access, { issuer, jwksUri: `${issuer}/jwks.json`, audience: "api" });
    expect(claims.token_use).toBe("access");
    const mw = bearerAuth({ issuer, audience: "api", jwksUri: `${issuer}/jwks.json` });
    const ctx = {
      req: { header: (name: string) => (name === "authorization" ? `Bearer ${access}` : undefined), raw: new Request(issuer, { headers: { authorization: `Bearer ${access}` } }) },
      json: (body: unknown, status?: number) => Response.json(body, { status }),
      set: () => {},
    };
    await expect(mw(ctx, async () => { throw new Error("route"); })).rejects.toThrow("route");
    await expect(
      completeAuthorizationCode({
        discovered: { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks.json` },
        callbackUrl: `${issuer}/cb?code=c&state=s`,
        clientId: "melody-sample",
        redirectUri: `${issuer}/cb`,
        expectedState: "s",
        expectedNonce: "n",
        verifier: "verifier",
      }),
    ).rejects.toBeInstanceOf(OauthClientError);
  } finally {
    globalThis.fetch = original;
    resetJwksCacheForTests();
  }
});
