import { describe, expect, test } from "bun:test";
import { dayKey, hashIpKey, networkKey, parseCap } from "../src/worker/budget";

const SECRET = "test-ip-secret";

describe("budget helpers", () => {
  test("HMAC ip_key is stable and does not contain the address", async () => {
    const key = await hashIpKey("203.0.113.9", SECRET);
    expect(key).toBe(await hashIpKey("203.0.113.9", SECRET));
    expect(key).not.toBe(await hashIpKey("198.51.100.9", SECRET));
    expect(key).not.toContain("203");
    expect(key).not.toContain("113");
    expect(key).toHaveLength(64);
  });

  test("networkKey is IPv4 /32 and IPv6 /64", () => {
    expect(networkKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(networkKey("203.0.113.9")).toBe("203.0.113.9");
    expect(networkKey("local")).toBe("local");
    expect(networkKey("2001:db8:abcd:1234:5678::1")).toBe("2001:db8:abcd:1234::");
    expect(networkKey("2001:db8:abcd:1234:9999::2")).toBe("2001:db8:abcd:1234::");
  });

  test("UTC day key and cap parsing", () => {
    expect(dayKey(Date.UTC(2026, 9, 14, 23, 50))).toBe("2026-10-14");
    expect(parseCap("200", 10)).toBe(200);
    expect(parseCap("", 12)).toBe(12);
    expect(parseCap("nope", 12)).toBe(12);
  });
});
