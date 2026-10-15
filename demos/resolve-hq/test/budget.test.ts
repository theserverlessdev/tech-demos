import { describe, expect, test } from "bun:test";
import { dayKey, hashIpKey, parseCap } from "../src/worker/budget";

describe("budget helpers", () => {
  test("parseCap falls back", () => {
    expect(parseCap("80", 12)).toBe(80);
    expect(parseCap("", 12)).toBe(12);
    expect(parseCap("-1", 12)).toBe(12);
  });

  test("dayKey is UTC YYYY-MM-DD", () => {
    expect(dayKey(Date.UTC(2026, 9, 15))).toBe("2026-10-15");
  });

  test("ip hash is hex and stable", async () => {
    const a = await hashIpKey("203.0.113.9", "secret");
    const b = await hashIpKey("203.0.113.9", "secret");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(await hashIpKey("198.51.100.9", "secret"));
  });
});
