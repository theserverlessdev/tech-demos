import { expect, test } from "bun:test";
import { hashIp, networkKey } from "../src/worker/ip";

test("an IPv6 /64 shares one network key and an IPv4 address stays whole", () => {
  const prefix = "2001:0db8:0001:0002::/64";
  expect(networkKey("2001:db8:1:2:3:4:5:6")).toBe(prefix);
  expect(networkKey("2001:db8:1:2::abcd")).toBe(prefix);
  expect(networkKey("203.0.113.8")).toBe("203.0.113.8");
});

test("the budget hash follows the /64, not the full address", async () => {
  const left = await hashIp("2001:db8:1:2:3:4:5:6", "secret");
  const right = await hashIp("2001:db8:1:2::ffff", "secret");
  const other = await hashIp("2001:db8:1:3::1", "secret");
  expect(left).toBe(right);
  expect(left).not.toBe(other);
});
