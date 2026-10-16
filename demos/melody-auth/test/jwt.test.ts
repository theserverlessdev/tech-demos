import { expect, test } from "bun:test";
import { decodeJwt, importSigningKey, importVerifyKey, publicJwkFromPrivate, signJwt, verifyJwt } from "../src/worker/jwt";

const DEMO: Parameters<typeof importSigningKey>[0] = {
  crv: "P-256",
  d: "p2rJ5XiDRi5pLLG9gzH4qoXbs2GKJ5KN3jruLjfILW0",
  kty: "EC",
  x: "7n9MQV0h4T-Efij9pjzvLnn-oJO9ML24pQucNjbzIm8",
  y: "2MvQMOmOe1_-fieWGS6QYIjtvzCAZWme26W1BNJ7qUM",
  kid: "melody-demo-1",
  alg: "ES256",
  use: "sig",
};

test("ES256 JWT signs and verifies", async () => {
  const key = await importSigningKey(DEMO);
  const pub = await importVerifyKey(publicJwkFromPrivate(DEMO));
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    { alg: "ES256", typ: "JWT", kid: "melody-demo-1" },
    { iss: "http://127.0.0.1:8788", sub: "usr_1", aud: "melody-sample", iat: now, exp: now + 60, nonce: "n1" },
    key,
  );
  const claims = await verifyJwt(token, pub, now);
  expect(claims?.sub).toBe("usr_1");
  expect(claims?.nonce).toBe("n1");
  expect(decodeJwt(token)?.header.kid).toBe("melody-demo-1");
  expect(await verifyJwt(token, pub, now + 120)).toBeNull();
});
