import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/worker/errors";
import { requireTurnstile, resolveTurnstileSecret, sessionGate, TURNSTILE_DUMMY_TOKEN, TURNSTILE_TEST_SECRET, verifyTurnstile } from "../src/worker/turnstile";

describe("turnstile gate", () => {
  test("test secret is rejected off localhost", () => {
    expect(resolveTurnstileSecret("local", TURNSTILE_TEST_SECRET).ok).toBe(true);
    expect(resolveTurnstileSecret("", TURNSTILE_TEST_SECRET).ok).toBe(false);
  });

  test("dummy token passes only with the test secret", async () => {
    expect(await verifyTurnstile(TURNSTILE_TEST_SECRET, TURNSTILE_DUMMY_TOKEN, "127.0.0.1", "127.0.0.1", "draft")).toBe(true);
    expect(await verifyTurnstile(TURNSTILE_TEST_SECRET, "", "127.0.0.1", "127.0.0.1", "draft")).toBe(false);
  });

  test("production request cannot use the test secret", async () => {
    const env = { ENVIRONMENT: "local", TURNSTILE_SECRET: TURNSTILE_TEST_SECRET } as Env;
    const remote = new Request("https://resolve-hq.tech-demos.theserverless.dev/api/tickets/x/draft", {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });
    await expect(requireTurnstile(env, remote, TURNSTILE_DUMMY_TOKEN, "draft")).rejects.toBeInstanceOf(HttpError);
  });

  test("sessionGate is off when the site key is empty", () => {
    expect(sessionGate({ ENVIRONMENT: "", TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET: "real" } as Env)).toBe("off");
    expect(sessionGate({ ENVIRONMENT: "local", TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET: TURNSTILE_TEST_SECRET } as Env)).toBe("local");
  });
});
