import { expect, test } from "bun:test";
import { BodyTooLargeError, decodeCookieValue, decodePathSegment, readBounded } from "../src/worker/body";
import { originAllowed } from "../src/worker/origin";
import { rateLimitKey } from "../src/worker/ip";

test("IPv4 and local keys stay unchanged", () => {
  expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
  expect(rateLimitKey("local")).toBe("local");
});

test("IPv6 keys collapse to the /64", () => {
  expect(rateLimitKey("2001:db8:abcd:12:0:0:0:1")).toBe("2001:0db8:abcd:0012::/64");
  expect(rateLimitKey("2001:db8:abcd:12::1")).toBe("2001:0db8:abcd:0012::/64");
  expect(rateLimitKey("2001:db8:abcd:13::9")).toBe("2001:0db8:abcd:0013::/64");
});

test("malformed percent-encoding is absent, not thrown", () => {
  expect(decodePathSegment("%E0%A4%A")).toBeNull();
  expect(decodeCookieValue("%E0%A4%A")).toBeNull();
  expect(decodePathSegment("org_ab")).toBe("org_ab");
});

test("readBounded rejects Content-Length over the cap before reading", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { "content-length": "9000" },
    body: "x".repeat(100),
  });
  await expect(readBounded(request, 8_000)).rejects.toBeInstanceOf(BodyTooLargeError);
});

test("readBounded stops after max bytes even without Content-Length", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    body: "n".repeat(50),
  });
  await expect(readBounded(request, 20)).rejects.toBeInstanceOf(BodyTooLargeError);
});

test("localhost Origins are only accepted on a local request host", () => {
  const local = new Request("http://127.0.0.1:8787/api/orgs", {
    headers: { origin: "http://localhost:5173" },
  });
  expect(originAllowed(local)).toBeTrue();

  const prod = new Request("https://company-brain.tech-demos.theserverless.dev/api/orgs", {
    headers: { origin: "http://localhost:5173" },
  });
  expect(originAllowed(prod)).toBeFalse();
});
