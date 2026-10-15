import { expect, test } from "bun:test";
import { DEV_HMAC_SECRET, hmacSecret, parseVisitorId, signVisitor, verifyVisitorToken } from "./visitor";

const id = "abcdefghij0123456789";

test("signVisitor and verifyVisitorToken round-trip", async () => {
  const token = await signVisitor("unit-test-secret", id);
  expect(token.startsWith(`${id}.`)).toBe(true);
  expect(await verifyVisitorToken("unit-test-secret", token)).toBe(id);
});

test("verifyVisitorToken rejects a missing, malformed, or wrong-key token", async () => {
  expect(await verifyVisitorToken("unit-test-secret", null)).toBeNull();
  expect(await verifyVisitorToken("unit-test-secret", id)).toBeNull();
  expect(await verifyVisitorToken("unit-test-secret", `${id}.${"ab".repeat(32)}`)).toBeNull();
  const token = await signVisitor("unit-test-secret", id);
  expect(await verifyVisitorToken("other-secret", token)).toBeNull();
});

test("parseVisitorId accepts only the id alphabet", () => {
  expect(parseVisitorId(id)).toBe(id);
  expect(parseVisitorId("short")).toBeNull();
  expect(parseVisitorId("ABC-not-valid")).toBeNull();
});

test("hmacSecret refuses the committed local key outside ENVIRONMENT=local", () => {
  expect(hmacSecret({ VISITOR_HMAC_SECRET: DEV_HMAC_SECRET, ENVIRONMENT: "local" })).toBe(DEV_HMAC_SECRET);
  expect(hmacSecret({ VISITOR_HMAC_SECRET: DEV_HMAC_SECRET, ENVIRONMENT: "" })).toBeNull();
  expect(hmacSecret({ VISITOR_HMAC_SECRET: "", ENVIRONMENT: "local" })).toBeNull();
});
