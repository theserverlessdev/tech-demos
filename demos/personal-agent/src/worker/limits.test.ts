import { expect, test } from "bun:test";
import { rateLimitKey } from "./limits";

test("IPv4 is unchanged", () => {
  expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
});

test("IPv6 is keyed on its /64", () => {
  expect(rateLimitKey("2001:db8:abcd:0012:0000:0000:0000:0001")).toBe("2001:0db8:abcd:0012::/64");
  expect(rateLimitKey("2001:db8:abcd:12::1")).toBe("2001:0db8:abcd:0012::/64");
  expect(rateLimitKey("2001:db8:abcd:12:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:abcd:0012::/64");
});

test("IPv4-mapped IPv6 uses the IPv4 address", () => {
  expect(rateLimitKey("::ffff:192.0.2.10")).toBe("192.0.2.10");
});
