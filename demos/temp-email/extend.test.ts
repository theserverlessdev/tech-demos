import { expect, test } from "bun:test";
import { hostedMode } from "./src/worker/auth.ts";
import { capHeader } from "./src/worker/ingest.ts";
import { rateLimitIp, webCreateLimitKey } from "./src/worker/ip.ts";
import { MAX_HEADER_CHARS, MINUTE_MS, WEB_MAX_TTL_MINUTES } from "./src/worker/limits.ts";
import { nextExpiry } from "./src/worker/ttl.ts";

test("web extend stops at created_at + 180 minutes", () => {
  const createdAt = 0;
  const first = nextExpiry({
    createdAt,
    expiresAt: 60 * MINUTE_MS,
    now: 0,
    minutes: 60,
    ceilingMinutes: WEB_MAX_TTL_MINUTES,
  });
  expect(first).toBe(120 * MINUTE_MS);
  let expiresAt = 60 * MINUTE_MS;
  for (let i = 0; i < 30; i++) {
    const next = nextExpiry({
      createdAt,
      expiresAt,
      now: 0,
      minutes: 60,
      ceilingMinutes: WEB_MAX_TTL_MINUTES,
    });
    if (next === null) break;
    expiresAt = next;
  }
  expect(expiresAt).toBe(WEB_MAX_TTL_MINUTES * MINUTE_MS);
  expect(
    nextExpiry({
      createdAt,
      expiresAt,
      now: 0,
      minutes: 60,
      ceilingMinutes: WEB_MAX_TTL_MINUTES,
    }),
  ).toBeNull();
});

test("agent extend uses the 1440-minute ceiling", () => {
  const createdAt = 10_000;
  const next = nextExpiry({
    createdAt,
    expiresAt: createdAt + 60 * MINUTE_MS,
    now: createdAt,
    minutes: 2000,
    ceilingMinutes: 1440,
  });
  expect(next).toBe(createdAt + 1440 * MINUTE_MS);
});

test("hosted mode gates the extra web-create bucket", () => {
  expect(hostedMode({ HOSTED_MODE: "true" })).toBe(true);
  expect(hostedMode({ HOSTED_MODE: "false" })).toBe(false);
  expect(webCreateLimitKey(true, "203.0.113.9")).toBe("webcreate:203.0.113.9");
  expect(webCreateLimitKey(false, "203.0.113.9")).toBeNull();
});

test("IPv6 rate-limit keys collapse to a /64", () => {
  const a = rateLimitIp("2001:db8:abcd:1234:5678:9abc:def0:1");
  const b = rateLimitIp("2001:db8:abcd:1234:ffff::2");
  expect(a).toBe("2001:0db8:abcd:1234");
  expect(b).toBe(a);
  expect(rateLimitIp("203.0.113.9")).toBe("203.0.113.9");
  expect(rateLimitIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
});

test("header fields cap at 2 KB", () => {
  const huge = "x".repeat(MAX_HEADER_CHARS + 50);
  expect(capHeader(huge)?.length).toBe(MAX_HEADER_CHARS);
  expect(capHeader("")).toBeNull();
  expect(capHeader("ok")).toBe("ok");
});
