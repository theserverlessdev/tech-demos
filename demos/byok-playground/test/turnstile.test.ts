import { describe, expect, test } from "bun:test";
import { isTestSiteKey, resolveTurnstileSecret, TURNSTILE_TEST_SECRET, verifyTurnstile } from "../src/worker/turnstile";

describe("Turnstile policy", () => {
  test("test secret is only allowed when ENVIRONMENT is local", () => {
    expect(resolveTurnstileSecret("local", TURNSTILE_TEST_SECRET).ok).toBe(true);
    const prod = resolveTurnstileSecret("", TURNSTILE_TEST_SECRET);
    expect(prod.ok).toBe(false);
    if (!prod.ok) expect(prod.reason).toBe("test_secret");
  });

  test("REPLACE_ME is not a test site key", () => {
    expect(isTestSiteKey("REPLACE_ME")).toBe(false);
    expect(isTestSiteKey("1x00000000000000000000AA")).toBe(true);
  });

  test("dummy token is accepted for the test secret with any expected action", async () => {
    expect(await verifyTurnstile(TURNSTILE_TEST_SECRET, "XXXX.DUMMY.TOKEN.XXXX", "127.0.0.1", "127.0.0.1", "session")).toBe(true);
    expect(await verifyTurnstile(TURNSTILE_TEST_SECRET, "XXXX.DUMMY.TOKEN.XXXX", "127.0.0.1", "127.0.0.1", "compare")).toBe(true);
  });
});
