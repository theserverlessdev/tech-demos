import { expect, test } from "bun:test";
import { DUMMY_TOKEN, TEST_TURNSTILE_SECRET, verifyTurnstile } from "./turnstile";

const QUESTION_LEAK = "question-text-must-stay-out-of-turnstile";

function fetchJson(body: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

test("a missing token is rejected", async () => {
  expect(await verifyTurnstile({ secret: "real-secret", token: "  ", ip: "203.0.113.4", dev: false, fetchImpl: fetchJson({}) })).toBe(
    "missing",
  );
});

test("a bad token is rejected in production", async () => {
  const result = await verifyTurnstile({
    secret: "real-secret",
    token: "not-a-real-token",
    ip: "203.0.113.4",
    dev: false,
    fetchImpl: fetchJson({ success: false, "error-codes": ["invalid-input-response"] }),
  });
  expect(result).toBe("rejected");
});

test("localhost and dummy tokens are rejected unless DEV=1", async () => {
  const dummy = await verifyTurnstile({
    secret: "real-secret",
    token: DUMMY_TOKEN,
    ip: "127.0.0.1",
    dev: false,
    fetchImpl: fetchJson({ success: true, hostname: "localhost" }),
  });
  expect(dummy).toBe("rejected");

  const testSecret = await verifyTurnstile({
    secret: TEST_TURNSTILE_SECRET,
    token: "some-token",
    ip: "203.0.113.4",
    dev: false,
    fetchImpl: fetchJson({ success: true, hostname: "example.com" }),
  });
  expect(testSecret).toBe("rejected");

  const localhostHost = await verifyTurnstile({
    secret: "real-secret",
    token: "site-token",
    ip: "203.0.113.4",
    dev: false,
    fetchImpl: fetchJson({ success: true, hostname: "localhost" }),
  });
  expect(localhostHost).toBe("rejected");

  const allowed = await verifyTurnstile({
    secret: TEST_TURNSTILE_SECRET,
    token: DUMMY_TOKEN,
    ip: "127.0.0.1",
    dev: true,
    fetchImpl: fetchJson({ success: false }),
  });
  expect(allowed).toBe("ok");

  const localHostWhenDev = await verifyTurnstile({
    secret: "real-secret",
    token: "site-token",
    ip: "127.0.0.1",
    dev: true,
    fetchImpl: fetchJson({ success: true, hostname: "127.0.0.1" }),
  });
  expect(localHostWhenDev).toBe("ok");
});

test("a production token from the hub host is accepted", async () => {
  const result = await verifyTurnstile({
    secret: "real-secret",
    token: "site-token",
    ip: "203.0.113.8",
    dev: false,
    fetchImpl: fetchJson({ success: true, hostname: "ask-the-hub.tech-demos.theserverless.dev" }),
  });
  expect(result).toBe("ok");
  expect(QUESTION_LEAK).not.toBe("logged");
});
