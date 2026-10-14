import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/worker/errors";
import { isTestSiteKey, requireTurnstile, resolveTurnstileSecret, sessionGate, TURNSTILE_DUMMY_TOKEN, TURNSTILE_TEST_SECRET, verifyTurnstile } from "../src/worker/turnstile";

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

  test("missing secret copy names proxy for a session mint", async () => {
    const env = { ENVIRONMENT: "", TURNSTILE_SECRET: "" } as Env;
    const req = new Request("https://byok-playground.tech-demos.theserverless.dev/api/session");
    try {
      await requireTurnstile(env, req, "tok", "session");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).message).toContain("Proxy is off");
      expect((err as HttpError).message).not.toContain("Compare is off");
    }
  });

  test("sessionGate is off for REPLACE_ME in production", () => {
    expect(sessionGate({ ENVIRONMENT: "", TURNSTILE_SITE_KEY: "REPLACE_ME", TURNSTILE_SECRET: "real" } as Env)).toBe("off");
    expect(sessionGate({ ENVIRONMENT: "local", TURNSTILE_SITE_KEY: "REPLACE_ME", TURNSTILE_SECRET: TURNSTILE_TEST_SECRET } as Env)).toBe("local");
  });
});
