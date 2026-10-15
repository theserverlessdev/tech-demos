import { expect, test } from "bun:test";
import { DEV_HMAC_SECRET, hmacSecret, parseVisitorId, parseVisitorToken, signVisitor, tokenExpiryMs, verifyVisitorToken } from "./visitor";

const id = "abcdefghij0123456789";
const exp = 1_800_000_000_000;

test("signVisitor and verifyVisitorToken round-trip with expiry", async () => {
  const token = await signVisitor("unit-test-secret", id, exp);
  expect(token.startsWith(`${id}.${exp}.`)).toBe(true);
  expect(parseVisitorToken(token)?.expiresAt).toBe(exp);
  expect(await verifyVisitorToken("unit-test-secret", token, exp - 1)).toBe(id);
});

test("verifyVisitorToken rejects a missing, malformed, expired, or wrong-key token", async () => {
  expect(await verifyVisitorToken("unit-test-secret", null)).toBeNull();
  expect(await verifyVisitorToken("unit-test-secret", id)).toBeNull();
  expect(await verifyVisitorToken("unit-test-secret", `${id}.${"ab".repeat(32)}`)).toBeNull();
  const token = await signVisitor("unit-test-secret", id, exp);
  expect(await verifyVisitorToken("other-secret", token, exp - 1)).toBeNull();
  expect(await verifyVisitorToken("unit-test-secret", token, exp)).toBeNull();
  expect(await verifyVisitorToken("unit-test-secret", token, exp + 1)).toBeNull();
});

test("tokenExpiryMs stays inside 1–168 hours", () => {
  const now = 1_700_000_000_000;
  expect(tokenExpiryMs(24, now) - now).toBe(24 * 3600 * 1000);
  expect(tokenExpiryMs(0, now) - now).toBe(1 * 3600 * 1000);
  expect(tokenExpiryMs(999, now) - now).toBe(168 * 3600 * 1000);
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
