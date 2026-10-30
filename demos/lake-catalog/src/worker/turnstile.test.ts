import { expect, test } from "bun:test";
import { allowedWidgetHost, DUMMY_TOKEN, TURNSTILE_ACTION, verifyTurnstile } from "./turnstile";

test("dummy tokens pass only in dev", async () => {
  expect(await verifyTurnstile({ secret: "real", token: DUMMY_TOKEN, ip: "203.0.113.4", dev: false })).toBe("rejected");
  expect(await verifyTurnstile({ secret: "1x0000000000000000000000000000000AA", token: DUMMY_TOKEN, ip: "127.0.0.1", dev: true })).toBe("ok");
});

test("a missing secret is unconfigured outside dev", async () => {
  expect(await verifyTurnstile({ secret: "", token: "solved", ip: "203.0.113.4", dev: false })).toBe("unconfigured");
  expect(await verifyTurnstile({ secret: "   ", token: DUMMY_TOKEN, ip: "203.0.113.4", dev: false })).toBe("unconfigured");
});

test("widget hosts are the demo host, the hub host, and local names while developing", () => {
  expect(allowedWidgetHost("lake-catalog.tech-demos.theserverless.dev")).toBe(true);
  expect(allowedWidgetHost("tech-demos.theserverless.dev")).toBe(true);
  expect(allowedWidgetHost("theserverless.dev")).toBe(false);
  expect(allowedWidgetHost("evil.theserverless.dev")).toBe(false);
  expect(allowedWidgetHost("eviltheserverless.dev")).toBe(false);
  expect(allowedWidgetHost("localhost", false)).toBe(false);
  expect(allowedWidgetHost("127.0.0.1:8787", true)).toBe(true);
});

test("siteverify must succeed, name an allowed host, and use the lake-catalog action", async () => {
  const ok = (async () =>
    new Response(
      JSON.stringify({
        success: true,
        hostname: "lake-catalog.tech-demos.theserverless.dev",
        action: TURNSTILE_ACTION,
      }),
    )) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real", token: "solved", ip: "203.0.113.4", dev: false, fetchImpl: ok })).toBe("ok");
  const hub = (async () =>
    new Response(JSON.stringify({ success: true, hostname: "tech-demos.theserverless.dev", action: TURNSTILE_ACTION }))) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real", token: "solved", ip: "203.0.113.4", dev: false, fetchImpl: hub })).toBe("ok");
  const wrongHost = (async () =>
    new Response(JSON.stringify({ success: true, hostname: "example.com", action: TURNSTILE_ACTION }))) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real", token: "solved", ip: "203.0.113.4", dev: false, fetchImpl: wrongHost })).toBe(
    "rejected",
  );
  const wrongAction = (async () =>
    new Response(
      JSON.stringify({ success: true, hostname: "lake-catalog.tech-demos.theserverless.dev", action: "other" }),
    )) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real", token: "solved", ip: "203.0.113.4", dev: false, fetchImpl: wrongAction })).toBe(
    "rejected",
  );
  const missingAction = (async () =>
    new Response(JSON.stringify({ success: true, hostname: "lake-catalog.tech-demos.theserverless.dev" }))) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real", token: "solved", ip: "203.0.113.4", dev: false, fetchImpl: missingAction })).toBe(
    "rejected",
  );
});
