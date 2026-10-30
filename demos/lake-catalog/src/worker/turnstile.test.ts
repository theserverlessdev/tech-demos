import { expect, test } from "bun:test";
import { allowedWidgetHost, DUMMY_TOKEN, verifyTurnstile } from "./turnstile";

test("dummy tokens pass only in dev", async () => {
  expect(await verifyTurnstile({ secret: "real", token: DUMMY_TOKEN, ip: "203.0.113.4", dev: false })).toBe("rejected");
  expect(await verifyTurnstile({ secret: "1x0000000000000000000000000000000AA", token: DUMMY_TOKEN, ip: "127.0.0.1", dev: true })).toBe("ok");
});

test("widget hosts are the zone and local names while developing", () => {
  expect(allowedWidgetHost("lake-catalog.tech-demos.theserverless.dev")).toBe(true);
  expect(allowedWidgetHost("theserverless.dev")).toBe(true);
  expect(allowedWidgetHost("eviltheserverless.dev")).toBe(false);
  expect(allowedWidgetHost("localhost", false)).toBe(false);
  expect(allowedWidgetHost("127.0.0.1:8787", true)).toBe(true);
});

test("siteverify must succeed and name an allowed host", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ success: true, hostname: "lake-catalog.tech-demos.theserverless.dev" }))) as typeof fetch;
  expect(
    await verifyTurnstile({ secret: "real", token: "solved", ip: "203.0.113.4", dev: false, fetchImpl }),
  ).toBe("ok");
  const wrong = (async () => new Response(JSON.stringify({ success: true, hostname: "example.com" }))) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real", token: "solved", ip: "203.0.113.4", dev: false, fetchImpl: wrong })).toBe(
    "rejected",
  );
});
