import { expect, test } from "bun:test";
import { CLIENT_TTL_MS, KEY_ROTATE_MS } from "../src/shared/types";
import { PAGE_CSP } from "../src/worker/headers";
import { DEMO_D, expireRingCacheForTests, resetRingForTests, rotateSigningKeys, signingContext } from "../src/worker/jwks";
import { codeRedirect, failRedirect } from "../src/worker/oidc";
import { formPostPage, type AuthorizeFields } from "../src/worker/pages";
import {
  actClaim,
  assertionLifetimeOk,
  audienceAllowed,
  capExpiryMs,
  deviceCodeForeign,
  exchangeExp,
  filterDcrGrants,
  isAccessJwt,
  isDcrClient,
  mayPostLogoutRedirect,
  microsoftIssuerOk,
  normalizeClientJwks,
  pkceDisposition,
  redirectUriShape,
  scopeSubset,
  shouldRotateLocalPassword,
  standardScope,
  subjectBoundToClient,
  tokenExchangeDenied,
  tokenVisibleToClient,
  upstreamEmailVerified,
  upstreamIdOk,
  validateRedirectList,
} from "../src/worker/policy";
import { rememberClientAssertion } from "../src/worker/store";
import { clientSecretMatches, hashClientSecret } from "../src/worker/secret";
import { fedCookieName, fedStateCookie } from "../src/worker/session";
import { insertApp, loadPar, userForFederation } from "../src/worker/store";

const fields: AuthorizeFields = {
  clientId: "melody-sample",
  redirectUri: "https://app.example/cb",
  state: "state",
  nonce: "nonce",
  scope: "openid",
  challenge: "challenge",
  method: "S256",
  responseType: "code",
  prompt: "",
  maxAge: "",
  loginHint: "",
  resource: "",
  responseMode: "query",
};

test("token exchange is denied unless the client is confidential and allowed", () => {
  expect(tokenExchangeDenied(false, "confidential")).toBeTrue();
  expect(tokenExchangeDenied(true, "public")).toBeTrue();
  expect(tokenExchangeDenied(true, "confidential")).toBeFalse();
});

test("exchanged scope and audience stay inside the subject token and the app", () => {
  expect(scopeSubset("openid email", "openid email profile")).toBe("openid email");
  expect(scopeSubset("admin", "openid email")).toBeNull();
  expect(scopeSubset(undefined, "openid")).toBe("openid");
  expect(audienceAllowed("https://api.example", '["https://api.example"]', "melody-machine")).toBeTrue();
  expect(audienceAllowed("https://other.example", '["https://api.example"]', "melody-machine")).toBeFalse();
  expect(audienceAllowed("melody-machine", null, "melody-machine")).toBeTrue();
  expect(subjectBoundToClient({ aud: "melody-machine", client_id: "other" }, "melody-machine")).toBeTrue();
  expect(subjectBoundToClient({ aud: "api", client_id: "other" }, "melody-machine")).toBeFalse();
  expect(deviceCodeForeign("other-client", "melody-sample")).toBeTrue();
  expect(deviceCodeForeign("melody-sample", "melody-sample")).toBeFalse();
  expect(tokenVisibleToClient("melody-sample", "api", "melody-machine", '["api"]')).toBeTrue();
  expect(tokenVisibleToClient("other", "https://elsewhere", "melody-machine", "[]")).toBeFalse();
  expect(exchangeExp(100, 150, 900)).toBe(150);
  expect(exchangeExp(100, 50, 900)).toBeNull();
  expect(actClaim("actor", { sub: "previous" })).toEqual({ sub: "actor", act: { sub: "previous" } });
});

test("dynamic registration strips privileged grants and unsafe metadata", () => {
  expect(filterDcrGrants(["authorization_code", "client_credentials", "urn:ietf:params:oauth:grant-type:token-exchange"], false)).toEqual(["authorization_code"]);
  expect(filterDcrGrants(["client_credentials"], true)).toEqual(["client_credentials"]);
  expect(standardScope("openid admin email")).toBe("openid email");
  expect(redirectUriShape("javascript:alert(1)")).toBeFalse();
  expect(redirectUriShape("https://app.example/cb#frag")).toBeFalse();
  expect(redirectUriShape("http://127.0.0.1:8788/")).toBeTrue();
  expect(redirectUriShape("http://evil.example/cb")).toBeFalse();
  expect(validateRedirectList(["https://a.example", "https://b.example", "https://c.example", "https://d.example", "https://e.example", "https://f.example"]).ok).toBeFalse();
  const jwks = normalizeClientJwks({ keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "secret", kid: "k" }] });
  expect(jwks.ok).toBeTrue();
  if (jwks.ok) expect(jwks.jwks).not.toContain("secret");
  expect(normalizeClientJwks({ keys: [{ kty: "RSA" }] }).ok).toBeFalse();
});

test("PKCE is verified whenever a challenge was stored", () => {
  expect(pkceDisposition("challenge", "verifier")).toBe("verify");
  expect(pkceDisposition("", "verifier")).toBe("reject");
  expect(pkceDisposition("", "")).toBe("skip");
});

test("client assertions expire quickly and access tokens are at+jwt", () => {
  const now = 1_000;
  expect(assertionLifetimeOk({ jti: "j", exp: now + 60, iat: now }, now)).toBeTrue();
  expect(assertionLifetimeOk({ exp: now + 60, iat: now }, now)).toBeFalse();
  expect(assertionLifetimeOk({ jti: "j", exp: now + 301, iat: now }, now)).toBeFalse();
  expect(isAccessJwt("at+jwt", "access")).toBeTrue();
  expect(isAccessJwt("JWT", "id")).toBeFalse();
  expect(isAccessJwt("JWT", "access")).toBeFalse();
});

test("logout redirects skip dynamically registered clients", () => {
  expect(isDcrClient("cid_abc", null)).toBeTrue();
  expect(mayPostLogoutRedirect("melody-sample", null)).toBeTrue();
  expect(mayPostLogoutRedirect("melody-sample", "hash")).toBeFalse();
  expect(capExpiryMs(Date.now() + 10 * 24 * 60 * 60 * 1000, Date.now(), 15 * 60 * 1000)).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 5);
});

test("federation email checks accept Microsoft xms_edov and reject a mismatched nonce", () => {
  expect(upstreamEmailVerified({ xms_edov: "1" })).toBeTrue();
  expect(upstreamEmailVerified({})).toBeFalse();
  expect(shouldRotateLocalPassword(0)).toBeTrue();
  expect(shouldRotateLocalPassword(1)).toBeFalse();
  const tid = "11111111-1111-1111-1111-111111111111";
  expect(microsoftIssuerOk(`https://login.microsoftonline.com/${tid}/v2.0`, tid)).toBeTrue();
  expect(microsoftIssuerOk("https://login.microsoftonline.com/common/v2.0", tid)).toBeFalse();
  const base = { sub: "s", email: "a@b.c", aud: "client", exp: 500, nonce: "n", email_verified: true, iss: "https://issuer.example" };
  expect(upstreamIdOk(base, { issuer: "https://issuer.example", clientId: "client", nonce: "n", nowSec: 400 })).toBeTrue();
  expect(upstreamIdOk(base, { issuer: "https://issuer.example", clientId: "client", nonce: "other", nowSec: 400 })).toBeFalse();
});

test("authorization responses include iss and form_post has no inline script", () => {
  const redirect = codeRedirect(fields, "code-1", "https://melody-auth.example");
  expect(redirect.headers.get("location")).toContain("iss=https%3A%2F%2Fmelody-auth.example");
  const posted = failRedirect({ ...fields, responseMode: "form_post" }, "access_denied", "no", "https://melody-auth.example");
  expect(posted.status).toBe(200);
  return posted.text().then((html) => {
    expect(html).toContain('src="/assets/formpost.js"');
    expect(html).toContain('name="iss"');
    expect(html).not.toContain("document.forms[0].submit()");
    expect(formPostPage("https://app.example/cb", { code: "c" })).toContain('src="/assets/formpost.js"');
    expect(formPostPage("https://app.example/cb", { code: "c" })).not.toContain("document.forms[0].submit()");
    const script = PAGE_CSP.split(";").find((part) => part.includes("script-src")) ?? "";
    expect(script).toContain("'self'");
    expect(script).not.toContain("unsafe-inline");
  });
});

test("PAR load deletes and returns in one statement", async () => {
  let sql = "";
  const db = {
    prepare(query: string) {
      sql = query;
      return {
        bind() {
          return this;
        },
        async first() {
          return { payload: '{"client_id":"melody-sample"}' };
        },
      };
    },
  };
  const payload = await loadPar(db as unknown as D1Database, "urn:req", "melody-sample", 10);
  expect(sql.startsWith("DELETE FROM par_requests")).toBeTrue();
  expect(sql).toContain("RETURNING payload");
  expect(payload?.client_id).toBe("melody-sample");
});

test("federation state cookie is host-bound only on the production issuer", () => {
  expect(fedCookieName(new Request("http://127.0.0.1:8788/fed/google"))).toBe("ma_fed");
  const prod = new Request("https://melody-auth.tech-demos.theserverless.dev/fed/google");
  expect(fedCookieName(prod)).toBe("__Host-ma_fed");
  expect(fedStateCookie("abc", prod, false)).toContain("__Host-ma_fed=abc");
  expect(fedStateCookie("abc", prod, false)).toContain("Secure");
});

test("linking an unverified local user rotates the password and drops sessions", async () => {
  const sql: string[] = [];
  const user = { id: "usr_1", email: "a@b.c", email_verified: 0, password_hash: "old", salt: "salt", created_at: 1, expires_at: Date.now() + 10_000 };
  const db = {
    prepare(query: string) {
      sql.push(query);
      return {
        bind() {
          return this;
        },
        async first() {
          return query.includes("WHERE email") || query.includes("WHERE id") ? user : null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
    async batch(stmts: { run: () => Promise<unknown> }[]) {
      for (const stmt of stmts) await stmt.run();
      return [];
    },
  };
  const linked = await userForFederation(db as unknown as D1Database, "a@b.c", Date.now(), "usr_1");
  expect(linked?.id).toBe("usr_1");
  expect(sql.some((query) => query.includes("UPDATE users SET email_verified"))).toBeFalse();

  sql.length = 0;
  const rotated = await userForFederation(db as unknown as D1Database, "a@b.c", Date.now(), null);
  expect(rotated?.email_verified).toBe(1);
  expect(rotated?.password_hash).not.toBe("old");
  expect(sql.some((query) => query.startsWith("DELETE FROM sessions"))).toBeTrue();
  expect(sql.some((query) => query.startsWith("DELETE FROM refresh_tokens"))).toBeTrue();
  expect(sql.some((query) => query.startsWith("DELETE FROM consents"))).toBeTrue();
});

test("insertApp keeps an explicit null client expiry", async () => {
  const calls: unknown[][] = [];
  const db = {
    prepare() {
      return {
        bind(...args: unknown[]) {
          calls.push(args);
          return this;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          return { client_id: "melody-machine", expires_at: null };
        },
      };
    },
  };
  await insertApp(db as unknown as D1Database, {
    clientId: "melody-machine",
    name: "Machine",
    redirectUris: [],
    grantTypes: ["client_credentials"],
    scopes: "api",
    authMethod: "client_secret_post",
    clientType: "confidential",
    now: 50,
    expiresAt: null,
  });
  expect(calls[0]?.includes(null)).toBeTrue();
  expect(calls[0]?.includes(50 + CLIENT_TTL_MS)).toBeFalse();
});

test("a client assertion jti can be stored only once", async () => {
  const changes = [1, 0];
  const db = {
    prepare(query: string) {
      expect(query).toContain("INSERT OR IGNORE INTO revoked_jtis");
      return {
        bind(jti: string) {
          expect(jti.startsWith("ca:client:")).toBeTrue();
          return this;
        },
        async run() {
          return { success: true, meta: { changes: changes.shift() ?? 0 } };
        },
      };
    },
  };
  expect(await rememberClientAssertion(db as unknown as D1Database, "client", "jti-1", 1_000)).toBeTrue();
  expect(await rememberClientAssertion(db as unknown as D1Database, "client", "jti-1", 1_000)).toBeFalse();
});

test("client secrets compare as SHA-256 with timingSafeEqual", async () => {
  const hash = await hashClientSecret("melody-machine-secret");
  expect(hash).toHaveLength(64);
  expect(await clientSecretMatches("melody-machine-secret", hash)).toBeTrue();
  expect(await clientSecretMatches("nope", hash)).toBeFalse();
  expect(await clientSecretMatches("melody-machine-secret", "")).toBeFalse();
});

test("key ring wraps d, ignores a read error, and refreshes after the cache window", async () => {
  resetRingForTests();
  const store = new Map<string, string>();
  let failGet = false;
  let puts = 0;
  const env = {
    ENVIRONMENT: "local",
    AUTH_PRIVATE_JWK: JSON.stringify({
      crv: "P-256",
      d: DEMO_D,
      kty: "EC",
      x: "7n9MQV0h4T-Efij9pjzvLnn-oJO9ML24pQucNjbzIm8",
      y: "2MvQMOmOe1_-fieWGS6QYIjtvzCAZWme26W1BNJ7qUM",
      kid: "melody-demo-1",
      alg: "ES256",
      use: "sig",
    }),
    AUTH_KEK: "11".repeat(32),
    KEYS: {
      async get() {
        if (failGet) throw new Error("kv");
        const raw = store.get("jwks:ring");
        return raw ? JSON.parse(raw) : null;
      },
      async put(_key: string, value: string) {
        puts += 1;
        store.set("jwks:ring", value);
      },
    },
  } as unknown as Env;

  const first = await signingContext(env);
  expect(first.kid).toBe("melody-demo-1");
  const stored = store.get("jwks:ring") ?? "";
  expect(stored.includes(DEMO_D)).toBeFalse();
  expect(stored.includes('"d"')).toBeFalse();

  const started = Date.now();
  await rotateSigningKeys(env, started + KEY_ROTATE_MS + 1);
  const published = store.get("jwks:ring") ?? "";
  expect(published.includes(DEMO_D)).toBeFalse();
  const before = await signingContext(env);
  const parsed = JSON.parse(published) as { currentKid: string; nextKid: string };
  store.set("jwks:ring", JSON.stringify({ ...JSON.parse(published), currentKid: parsed.nextKid }));
  expect((await signingContext(env)).kid).toBe(before.kid);
  expireRingCacheForTests();
  expect((await signingContext(env)).kid).toBe(parsed.nextKid);

  puts = 0;
  failGet = true;
  expireRingCacheForTests();
  expect((await signingContext(env)).kid).toBe(parsed.nextKid);
  expect(puts).toBe(0);
  resetRingForTests();
});

test("a seed failure does not turn the request into a 500", async () => {
  const worker = (await import("../src/worker/index")).default;
  const env = {
    ENVIRONMENT: "local",
    DB: {
      prepare() {
        throw new Error("d1 down");
      },
    },
    AUTH_PRIVATE_JWK: "{}",
  } as unknown as Env;
  const res = await worker.fetch(new Request("http://127.0.0.1:8788/api/health"), env);
  expect(res.status).toBe(503);
});
