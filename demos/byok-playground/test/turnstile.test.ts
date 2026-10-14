import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/worker/errors";
import { isTestSiteKey, requireTurnstile, resolveTurnstileSecret, TURNSTILE_DUMMY_TOKEN, TURNSTILE_TEST_SECRET, verifyTurnstile } from "../src/worker/turnstile";

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

  test("test secret requires ENVIRONMENT=local and a localhost request", async () => {
    const env = { ENVIRONMENT: "local", TURNSTILE_SECRET: TURNSTILE_TEST_SECRET } as Env;
    const remote = new Request("https://byok-playground.tech-demos.theserverless.dev/api/session", {
      headers: { "cf-connecting-ip": "8.8.8.8" },
    });
    await expect(requireTurnstile(env, remote, TURNSTILE_DUMMY_TOKEN, "session")).rejects.toBeInstanceOf(HttpError);

    const local = new Request("http://127.0.0.1:8787/api/session", { headers: { "cf-connecting-ip": "127.0.0.1" } });
    await expect(requireTurnstile(env, local, TURNSTILE_DUMMY_TOKEN, "session")).resolves.toBeUndefined();
  });
});
