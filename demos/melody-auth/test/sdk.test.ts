import { expect, test } from "bun:test";
import { importSigningKey, publicJwkFromPrivate, signJwt, generateEs256 } from "../src/worker/jwt";
import { OauthClientError, protect, randomToken, resetJwksCacheForTests, verifyAccessToken, verifyIdToken, verifyJwt, discover } from "../sdk/src/index";

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
  } finally {
    globalThis.fetch = original;
    resetJwksCacheForTests();
  }
});
