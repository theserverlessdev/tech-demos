import { expect, test } from "bun:test";
import { DEMO_HOST, HUB_HOST, TURNSTILE_ACTION } from "../shared/protocol";
import { DUMMY_TOKEN, TEST_TURNSTILE_SECRET, allowedWidgetHost, localEnabled, verifyTurnstile } from "./turnstile";

test("exact hosts and the action are required", async () => {
  expect(allowedWidgetHost(DEMO_HOST, false)).toBe(true);
  expect(allowedWidgetHost(HUB_HOST, false)).toBe(true);
  expect(allowedWidgetHost("evil-theserverless.dev", false)).toBe(false);
  expect(allowedWidgetHost("localhost", false)).toBe(false);
  expect(allowedWidgetHost("localhost", true)).toBe(true);
  expect(localEnabled("1", "x402-pay.tech-demos.theserverless.dev", "9abc")).toBe(false);
  expect(localEnabled("1", "127.0.0.1")).toBe(true);
  expect(localEnabled("0", "127.0.0.1")).toBe(false);
  expect(localEnabled("1", "tech-demos.theserverless.dev", "9abc")).toBe(false);
  expect(localEnabled("1", "tech-demos.theserverless.dev", null)).toBe(true);

  const calls: { body: string }[] = [];
  const ok = await verifyTurnstile({
    secret: "real-secret",
    token: "token-from-widget",
    ip: "203.0.113.4",
    local: false,
    fetchImpl: async (_url, init) => {
      calls.push({ body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ success: true, hostname: DEMO_HOST, action: TURNSTILE_ACTION }));
    },
  });
  expect(ok).toBe("ok");
  expect(calls[0]?.body).toContain("real-secret");

  const wrongAction = await verifyTurnstile({
    secret: "real-secret",
    token: "token-from-widget",
    ip: "203.0.113.4",
    local: false,
    fetchImpl: async () => new Response(JSON.stringify({ success: true, hostname: DEMO_HOST, action: "other-demo" })),
  });
  expect(wrongAction).toBe("rejected");

  const wrongHost = await verifyTurnstile({
    secret: "real-secret",
    token: "token-from-widget",
    ip: "203.0.113.4",
    local: false,
    fetchImpl: async () => new Response(JSON.stringify({ success: true, hostname: "not-this-demo.example", action: TURNSTILE_ACTION })),
  });
  expect(wrongHost).toBe("rejected");

  const dummyOnProd = await verifyTurnstile({ secret: TEST_TURNSTILE_SECRET, token: DUMMY_TOKEN, ip: "", local: false });
  expect(dummyOnProd).toBe("rejected");
  const dummyLocal = await verifyTurnstile({ secret: TEST_TURNSTILE_SECRET, token: DUMMY_TOKEN, ip: "", local: true });
  expect(dummyLocal).toBe("ok");
});
