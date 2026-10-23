import { expect, test } from "bun:test";
import { newPasswordRecord, passwordMatches } from "./auth";
import { tokensMatch } from "./crypto";
import { envMintEnabled, resolveMintEnabled } from "./router";

test("passwords are stored as a hash and compared in constant time", async () => {
  const record = await newPasswordRecord("correct horse");
  expect(record.hash).not.toContain("correct");
  expect(record.salt).not.toContain("correct");
  expect(await passwordMatches("correct horse", record.salt, record.hash)).toBe(true);
  expect(await passwordMatches("wrong", record.salt, record.hash)).toBe(false);
  expect(await passwordMatches("wrong", null, null)).toBe(false);
});

test("admin tokens compare equal-length hashes", async () => {
  expect(await tokensMatch("admin-secret", "admin-secret")).toBe(true);
  expect(await tokensMatch("a", "admin-secret-but-longer")).toBe(false);
  expect(await tokensMatch("", "admin-secret")).toBe(false);
});

test("minting is off unless the env string is true and the kill switch is clear", () => {
  expect(envMintEnabled(undefined)).toBe(false);
  expect(envMintEnabled("false")).toBe(false);
  expect(envMintEnabled("true")).toBe(true);
  expect(resolveMintEnabled(false, false)).toBe(false);
  expect(resolveMintEnabled(true, true)).toBe(false);
  expect(resolveMintEnabled(true, false)).toBe(true);
});
