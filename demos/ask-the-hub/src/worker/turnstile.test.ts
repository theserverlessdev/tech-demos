import { expect, test } from "bun:test";
import { DUMMY_TOKEN, TEST_TURNSTILE_SECRET, TURNSTILE_ACTION, verifyTurnstile } from "./turnstile";

const QUESTION_LEAK = "question-text-must-stay-out-of-turnstile";

function fetchJson(body: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

const okHost = { success: true, hostname: "ask-the-hub.tech-demos.theserverless.dev", action: TURNSTILE_ACTION };

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
    fetchImpl: fetchJson({ success: true, hostname: "localhost", action: TURNSTILE_ACTION }),
  });
  expect(dummy).toBe("rejected");

  const testSecret = await verifyTurnstile({
    secret: TEST_TURNSTILE_SECRET,
    token: "some-token",
    ip: "203.0.113.4",
    dev: false,
    fetchImpl: fetchJson({ success: true, hostname: "example.com", action: TURNSTILE_ACTION }),
  });
  expect(testSecret).toBe("rejected");

  const localhostHost = await verifyTurnstile({
    secret: "real-secret",
    token: "site-token",
    ip: "203.0.113.4",
    dev: false,
    fetchImpl: fetchJson({ success: true, hostname: "localhost", action: TURNSTILE_ACTION }),
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
    fetchImpl: fetchJson({ success: true, hostname: "127.0.0.1", action: TURNSTILE_ACTION }),
  });
  expect(localHostWhenDev).toBe("ok");
});

test("a production token from an allowed host is accepted and the question stays out of siteverify", async () => {
  let posted = "";
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    posted = String(init?.body ?? "");
    return new Response(JSON.stringify(okHost), { status: 200 });
  }) as typeof fetch;
  const result = await verifyTurnstile({
    secret: "real-secret",
    token: "site-token",
    ip: "203.0.113.8",
    dev: false,
    fetchImpl,
  });
  expect(result).toBe("ok");
  expect(posted).toContain("site-token");
  expect(posted).not.toContain(QUESTION_LEAK);
});

test("a sibling hostname or the wrong widget action is rejected", async () => {
  const sibling = await verifyTurnstile({
    secret: "real-secret",
    token: "site-token",
    ip: "203.0.113.8",
    dev: false,
    fetchImpl: fetchJson({ success: true, hostname: "evil.theserverless.dev", action: TURNSTILE_ACTION }),
  });
  expect(sibling).toBe("rejected");

  const apex = await verifyTurnstile({
    secret: "real-secret",
    token: "site-token",
    ip: "203.0.113.8",
    dev: false,
    fetchImpl: fetchJson({ success: true, hostname: "theserverless.dev", action: TURNSTILE_ACTION }),
  });
  expect(apex).toBe("rejected");

  const wrongAction = await verifyTurnstile({
    secret: "real-secret",
    token: "site-token",
    ip: "203.0.113.8",
    dev: false,
    fetchImpl: fetchJson({ success: true, hostname: "tech-demos.theserverless.dev", action: "managed" }),
  });
  expect(wrongAction).toBe("rejected");
});
