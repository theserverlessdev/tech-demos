import { expect, test } from "bun:test";
import { duckdbSnippet, signConnection, signJwt, verifyConnection, verifyJwt } from "./jwt";

const secret = "test-secret";

test("a signed token verifies and an expired one does not", async () => {
  const now = 1_700_000_000;
  const token = await signJwt(secret, { role: "viewer", catalog: "orders", iat: now, exp: now + 600 });
  expect(await verifyJwt(secret, token, now + 10)).toEqual({
    role: "viewer",
    catalog: "orders",
    iat: now,
    exp: now + 600,
  });
  expect(await verifyJwt(secret, token, now + 601)).toBeNull();
  expect(await verifyJwt("other", token, now + 10)).toBeNull();
});

test("connection ids are signed", async () => {
  const payload = { catalog: "orders" as const, role: "analyst" as const, exp: 50, sid: "abcdefgh" };
  const token = await signConnection(secret, payload);
  expect(await verifyConnection(secret, token, 10)).toEqual(payload);
  expect(await verifyConnection(secret, token, 50)).toBeNull();
});

test("the CLI snippet carries the token and the quack scope", () => {
  const text = duckdbSnippet({ token: "abc.def.ghi", host: "lake-catalog.tech-demos.theserverless.dev", secure: true });
  expect(text).toContain("TOKEN 'abc.def.ghi'");
  expect(text).toContain("quack:lake-catalog.tech-demos.theserverless.dev:443");
  expect(text).toContain("READ_ONLY");
  expect(text).not.toContain("SELECT customer");
});
