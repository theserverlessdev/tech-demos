import { expect, test } from "bun:test";
import {
  DUMMY_TOKEN,
  TEST_TURNSTILE_SECRET,
  TEST_TURNSTILE_SITE_KEY,
  allowedWidgetHost,
  assessTurnstile,
  verifyTurnstile,
} from "./turnstile";

test("production stays closed on the test pair and local mode opens it", () => {
  expect(assessTurnstile({ secret: "", siteKey: TEST_TURNSTILE_SITE_KEY, local: false })).toBe("closed");
  expect(assessTurnstile({ secret: TEST_TURNSTILE_SECRET, siteKey: TEST_TURNSTILE_SITE_KEY, local: false })).toBe("closed");
  expect(assessTurnstile({ secret: TEST_TURNSTILE_SECRET, siteKey: TEST_TURNSTILE_SITE_KEY, local: true })).toBe("open");
  expect(assessTurnstile({ secret: "real-secret", siteKey: "0x4AAAAAAFRUoj5qDpf7XyIW", local: false })).toBe("open");
});

test("widget hosts are the two demo hosts, plus loopback only when local", () => {
  expect(allowedWidgetHost("pairlane.tech-demos.theserverless.dev", false)).toBe(true);
  expect(allowedWidgetHost("tech-demos.theserverless.dev", false)).toBe(true);
  expect(allowedWidgetHost("theserverless.dev", false)).toBe(false);
  expect(allowedWidgetHost("other.tech-demos.theserverless.dev", false)).toBe(false);
  expect(allowedWidgetHost("nottheserverless.dev", false)).toBe(false);
  expect(allowedWidgetHost("theserverless.dev.evil.com", false)).toBe(false);
  expect(allowedWidgetHost("localhost", false)).toBe(false);
  expect(allowedWidgetHost("example.com", true)).toBe(false);
  expect(allowedWidgetHost("localhost", true)).toBe(true);
  expect(allowedWidgetHost("127.0.0.1", true)).toBe(true);
});

test("the dummy token passes only for the local test pair", async () => {
  expect(await verifyTurnstile({ secret: TEST_TURNSTILE_SECRET, token: DUMMY_TOKEN, ip: "127.0.0.1", local: true })).toBe("ok");
  expect(await verifyTurnstile({ secret: "real-secret", token: DUMMY_TOKEN, ip: "1.2.3.4", local: false })).toBe("rejected");
  expect(await verifyTurnstile({ secret: TEST_TURNSTILE_SECRET, token: DUMMY_TOKEN, ip: "1.2.3.4", local: false })).toBe("rejected");
  expect(await verifyTurnstile({ secret: "real-secret", token: "", ip: "1.2.3.4", local: false })).toBe("missing");
});

test("siteverify requires the pairlane action and an exact demo host", async () => {
  const ok = (async () =>
    Response.json({ success: true, hostname: "pairlane.tech-demos.theserverless.dev", action: "pairlane" })) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real-secret", token: "solved-token", ip: "1.2.3.4", local: false, fetchImpl: ok })).toBe("ok");
  const hub = (async () =>
    Response.json({ success: true, hostname: "tech-demos.theserverless.dev", action: "pairlane" })) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real-secret", token: "solved-token", ip: "1.2.3.4", local: false, fetchImpl: hub })).toBe("ok");
  const wrongAction = (async () =>
    Response.json({ success: true, hostname: "pairlane.tech-demos.theserverless.dev", action: "other" })) as typeof fetch;
  expect(
    await verifyTurnstile({ secret: "real-secret", token: "solved-token", ip: "1.2.3.4", local: false, fetchImpl: wrongAction }),
  ).toBe("rejected");
  const missingAction = (async () =>
    Response.json({ success: true, hostname: "pairlane.tech-demos.theserverless.dev" })) as typeof fetch;
  expect(
    await verifyTurnstile({ secret: "real-secret", token: "solved-token", ip: "1.2.3.4", local: false, fetchImpl: missingAction }),
  ).toBe("rejected");
  const evil = (async () => Response.json({ success: true, hostname: "evil.example", action: "pairlane" })) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real-secret", token: "solved-token", ip: "1.2.3.4", local: false, fetchImpl: evil })).toBe(
    "rejected",
  );
  const sibling = (async () =>
    Response.json({ success: true, hostname: "other.tech-demos.theserverless.dev", action: "pairlane" })) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real-secret", token: "solved-token", ip: "1.2.3.4", local: false, fetchImpl: sibling })).toBe(
    "rejected",
  );
  const failed = (async () =>
    Response.json({ success: false, hostname: "pairlane.tech-demos.theserverless.dev", action: "pairlane" })) as typeof fetch;
  expect(
    await verifyTurnstile({ secret: "real-secret", token: "solved-token", ip: "1.2.3.4", local: false, fetchImpl: failed }),
  ).toBe("rejected");
});
