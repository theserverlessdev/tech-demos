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

  test("mapped IPv6 uses the embedded IPv4 as the network key", () => {
    expect(networkKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(networkKey("local")).toBe("local");
  });

  test("UTC day key and cap parsing", () => {
    expect(dayKey(Date.UTC(2026, 9, 14, 23, 50))).toBe("2026-10-14");
    expect(parseCap("200", 10)).toBe(200);
    expect(parseCap("", 12)).toBe(12);
    expect(parseCap("nope", 12)).toBe(12);
  });
});
