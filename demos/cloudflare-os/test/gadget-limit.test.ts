import { expect, test } from "bun:test";
import { assertGadgetLimit, gadgetLimitKeys, networkKey } from "../src/worker/limits";

test("IPv4 is unchanged", () => {
  expect(networkKey("203.0.113.9")).toBe("203.0.113.9");
});

test("IPv6 is keyed on its /64", () => {
  expect(networkKey("2001:db8:abcd:0012:0000:0000:0000:0001")).toBe("2001:0db8:abcd:0012::/64");
  expect(networkKey("2001:db8:abcd:12::1")).toBe("2001:0db8:abcd:0012::/64");
  expect(networkKey("2001:db8:abcd:12:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:abcd:0012::/64");
});

test("IPv4-mapped IPv6 uses the IPv4 address", () => {
  expect(networkKey("::ffff:192.0.2.10")).toBe("192.0.2.10");
});

test("gadget limit keys cover the network and the workspace", () => {
  const keys = gadgetLimitKeys("2001:db8:abcd:12::9", "workspace1");
  expect(keys.map((row) => row.key)).toEqual(["2001:0db8:abcd:0012::/64", "ws:workspace1"]);
});

test("assertGadgetLimit checks IP then workspace and throws on the first failure", async () => {
  const seen: string[] = [];
  const limiter = {
    async limit({ key }: { key: string }) {
      seen.push(key);
      return { success: key !== "ws:busy" };
    },
  } as unknown as RateLimit;
  await expect(assertGadgetLimit(limiter, "203.0.113.9", "busy")).rejects.toThrow(/this workspace/);
  expect(seen).toEqual(["203.0.113.9", "ws:busy"]);
});

test("assertGadgetLimit stops before the workspace key when the IP is blocked", async () => {
  const seen: string[] = [];
  const limiter = {
    async limit({ key }: { key: string }) {
      seen.push(key);
      return { success: false };
    },
  } as unknown as RateLimit;
  await expect(assertGadgetLimit(limiter, "203.0.113.9", "ok")).rejects.toThrow(/your network/);
  expect(seen).toEqual(["203.0.113.9"]);
});

test("assertGadgetLimit fails closed when the binding throws", async () => {
  const limiter = {
    async limit() {
      throw new Error("binding down");
    },
  } as unknown as RateLimit;
  await expect(assertGadgetLimit(limiter, "203.0.113.9", "ok")).rejects.toThrow("binding down");
});

test("the gadget proxy and agent callGadget both await the rate limit", async () => {
  const workspace = await Bun.file(new URL("../src/worker/workspace.ts", import.meta.url)).text();
  const wrangler = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text();
  expect(wrangler).toContain('"name": "GADGET_LIMIT"');
  expect(wrangler).toContain('"namespace_id": "7303"');
  expect(workspace).toContain("assertGadgetLimit(this.env.GADGET_LIMIT");
  const proxyIdx = workspace.indexOf("connectToGadget(id: string, viewer: Viewer, ip: string)");
  const callIdx = workspace.indexOf("async #callGadget");
  expect(proxyIdx).toBeGreaterThan(0);
  expect(callIdx).toBeGreaterThan(0);
  expect(workspace.slice(proxyIdx, proxyIdx + 1600)).toContain("assertGadgetLimit");
  expect(workspace.slice(callIdx, callIdx + 500)).toContain("assertGadgetLimit");
});
