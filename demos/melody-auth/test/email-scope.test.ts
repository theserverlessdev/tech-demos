import { expect, test } from "bun:test";
import { decodeJwt } from "../src/worker/jwt";
import { resetRingForTests } from "../src/worker/jwks";
import { mintTokens } from "../src/worker/tokens";

const DEMO = {
  crv: "P-256",
  d: "p2rJ5XiDRi5pLLG9gzH4qoXbs2GKJ5KN3jruLjfILW0",
  kty: "EC",
  x: "7n9MQV0h4T-Efij9pjzvLnn-oJO9ML24pQucNjbzIm8",
  y: "2MvQMOmOe1_-fieWGS6QYIjtvzCAZWme26W1BNJ7qUM",
  kid: "melody-demo-1",
  alg: "ES256",
  use: "sig",
};

function env(): Env {
  const store = new Map<string, string>();
  return {
    ENVIRONMENT: "local",
    AUTH_PRIVATE_JWK: JSON.stringify(DEMO),
    AUTH_KEK: "",
    KEYS: {
      async get() {
        return null;
      },
      async put(key: string, value: string) {
        store.set(String(key), value);
      },
    },
  } as unknown as Env;
}

async function minted(scope: string) {
  resetRingForTests();
  return mintTokens(env(), new Request("http://127.0.0.1:8788/token"), {
    userId: "usr_1",
    email: "a@b.c",
    emailVerified: true,
    clientId: "app",
    scope,
    nonce: "n",
    now: Date.now(),
    skipRefresh: true,
  });
}

test("openid-only tokens omit email claims", async () => {
  const tokens = await minted("openid");
  const access = decodeJwt(tokens.access_token)?.claims;
  const id = decodeJwt(tokens.id_token ?? "")?.claims;
  expect(access?.scope).toBe("openid");
  expect(access?.email).toBeUndefined();
  expect(access?.email_verified).toBeUndefined();
  expect(id?.email).toBeUndefined();
  expect(id?.email_verified).toBeUndefined();
});

test("the email scope adds email claims to the access token and the id token", async () => {
  const tokens = await minted("openid email");
  const access = decodeJwt(tokens.access_token)?.claims;
  const id = decodeJwt(tokens.id_token ?? "")?.claims;
  expect(access?.email).toBe("a@b.c");
  expect(access?.email_verified).toBe(true);
  expect(id?.email).toBe("a@b.c");
  expect(id?.email_verified).toBe(true);
});
