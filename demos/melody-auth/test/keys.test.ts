import { expect, test } from "bun:test";
import { KEY_ROTATE_MS } from "../src/shared/types";
import { decodeJwt, generateEs256, importSigningKey, publicJwkFromPrivate, signJwt, verifyJwtWithKeys } from "../src/worker/jwt";
import { jwksDocument, resetRingForTests, rotateSigningKeys } from "../src/worker/jwks";

const DEMO = {
  crv: "P-256" as const,
  d: "p2rJ5XiDRi5pLLG9gzH4qoXbs2GKJ5KN3jruLjfILW0",
  kty: "EC" as const,
  x: "7n9MQV0h4T-Efij9pjzvLnn-oJO9ML24pQucNjbzIm8",
  y: "2MvQMOmOe1_-fieWGS6QYIjtvzCAZWme26W1BNJ7qUM",
  kid: "melody-demo-1",
  alg: "ES256" as const,
  use: "sig" as const,
};

function mockEnv(jwk = JSON.stringify(DEMO)): Env {
  const store = new Map<string, string>();
  return {
    ENVIRONMENT: "local",
    AUTH_PRIVATE_JWK: jwk,
    KEYS: {
      async get(key: string, type?: string) {
        const raw = store.get(String(key));
        if (!raw) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      async put(key: string, value: string) {
        store.set(String(key), value);
      },
    },
  } as unknown as Env;
}

test("at+jwt access tokens decode", async () => {
  const key = await importSigningKey(DEMO);
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    { alg: "ES256", typ: "at+jwt", kid: "melody-demo-1" },
    { iss: "http://127.0.0.1:8788", sub: "usr_1", aud: "api", iat: now, exp: now + 60, jti: "jti_1", client_id: "melody-sample" },
    key,
  );
  expect(decodeJwt(token)?.header.typ).toBe("at+jwt");
  const claims = await verifyJwtWithKeys(token, [publicJwkFromPrivate(DEMO)], now);
  expect(claims?.jti).toBe("jti_1");
});

test("rotateSigningKeys keeps the previous kid for verification", async () => {
  resetRingForTests();
  const env = mockEnv();
  const first = await rotateSigningKeys(env, Date.now());
  expect(first.rotated).toBeFalse();
  const rotated = await rotateSigningKeys(env, Date.now() + KEY_ROTATE_MS + 1);
  expect(rotated.rotated).toBeTrue();
  expect(rotated.kid).not.toBe("melody-demo-1");
  const doc = await jwksDocument(env);
  expect(doc.keys.length).toBeGreaterThanOrEqual(2);
  expect(doc.keys.some((key) => key.kid === "melody-demo-1")).toBeTrue();
  expect(doc.keys.some((key) => key.kid === rotated.kid)).toBeTrue();
  resetRingForTests();
});

test("generateEs256 yields a P-256 private JWK with kid", async () => {
  const jwk = await generateEs256("melody-test");
  expect(jwk.kty).toBe("EC");
  expect(jwk.kid).toBe("melody-test");
  expect(jwk.d.length).toBeGreaterThan(10);
});
