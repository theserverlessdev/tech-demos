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

test("widget hosts are the serverless.dev zone, plus loopback only when local", () => {
  expect(allowedWidgetHost("pairlane.tech-demos.theserverless.dev", false)).toBe(true);
  expect(allowedWidgetHost("tech-demos.theserverless.dev", false)).toBe(true);
  expect(allowedWidgetHost("theserverless.dev", false)).toBe(true);
  expect(allowedWidgetHost("nottheserverless.dev", false)).toBe(false);
  expect(allowedWidgetHost("theserverless.dev.evil.com", false)).toBe(false);
  expect(allowedWidgetHost("localhost", false)).toBe(false);
  expect(allowedWidgetHost("example.com", false)).toBe(false);
  expect(allowedWidgetHost("localhost", true)).toBe(true);
  expect(allowedWidgetHost("example.com", true)).toBe(true);
});

test("the dummy token passes only for the local test pair", async () => {
  expect(await verifyTurnstile({ secret: TEST_TURNSTILE_SECRET, token: DUMMY_TOKEN, ip: "127.0.0.1", local: true })).toBe("ok");
  expect(await verifyTurnstile({ secret: "real-secret", token: DUMMY_TOKEN, ip: "1.2.3.4", local: false })).toBe("rejected");
  expect(await verifyTurnstile({ secret: TEST_TURNSTILE_SECRET, token: DUMMY_TOKEN, ip: "1.2.3.4", local: false })).toBe("rejected");
  expect(await verifyTurnstile({ secret: "real-secret", token: "", ip: "1.2.3.4", local: false })).toBe("missing");
});

test("siteverify hostnames are checked and a failed check is rejected", async () => {
  const fetchImpl = (async () => Response.json({ success: true, hostname: "pairlane.tech-demos.theserverless.dev" })) as typeof fetch;
  expect(
    await verifyTurnstile({ secret: "real-secret", token: "solved-token", ip: "1.2.3.4", local: false, fetchImpl }),
  ).toBe("ok");
  const evil = (async () => Response.json({ success: true, hostname: "evil.example" })) as typeof fetch;
  expect(await verifyTurnstile({ secret: "real-secret", token: "solved-token", ip: "1.2.3.4", local: false, fetchImpl: evil })).toBe(
    "rejected",
  );
  const failed = (async () => Response.json({ success: false, hostname: "pairlane.tech-demos.theserverless.dev" })) as typeof fetch;
  expect(
    await verifyTurnstile({ secret: "real-secret", token: "solved-token", ip: "1.2.3.4", local: false, fetchImpl: failed }),
  ).toBe("rejected");
});
