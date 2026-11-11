import { expect, test } from "bun:test";
import { loaderClaimDecision, loaderIpCap, LOADER_IP_SHARE } from "../src/worker/loader";

test("each network gets 15% of the daily Dynamic Worker cap", () => {
  expect(LOADER_IP_SHARE).toBe(0.15);
  expect(loaderIpCap(60)).toBe(9);
  expect(loaderIpCap(1)).toBe(1);
});

test("a reused Dynamic Worker id does not increment the count", () => {
  expect(
    loaderClaimDecision({ alreadyClaimed: true, globalCount: 60, ipCount: 9, globalCap: 60, ipCap: 9 }),
  ).toEqual({ ok: true, count: 60, cap: 60 });
});

test("the global cap rejects a new id even when the network still has room", () => {
  expect(
    loaderClaimDecision({ alreadyClaimed: false, globalCount: 60, ipCount: 0, globalCap: 60, ipCap: 9 }),
  ).toEqual({ ok: false, count: 60, cap: 60, reason: "global" });
});

test("one network cannot mint the whole daily cap", () => {
  expect(
    loaderClaimDecision({ alreadyClaimed: false, globalCount: 8, ipCount: 9, globalCap: 60, ipCap: 9 }),
  ).toEqual({ ok: false, count: 8, cap: 60, reason: "ip" });
});

test("a new id from a network under its share increments the global count", () => {
  expect(
    loaderClaimDecision({ alreadyClaimed: false, globalCount: 8, ipCount: 2, globalCap: 60, ipCap: 9 }),
  ).toEqual({ ok: true, count: 9, cap: 60 });
});

test("agent gadget tools share CODE_LIMIT and pass the caller IP into the loader meter", async () => {
  const workspace = await Bun.file(new URL("../src/worker/workspace.ts", import.meta.url)).text();
  const hostIdx = workspace.indexOf("#agentHost(viewer: Viewer, ip: string)");
  expect(hostIdx).toBeGreaterThan(0);
  const host = workspace.slice(hostIdx, hostIdx + 2200);
  expect(host).toContain("await this.assertCodeLimit(ip)");
  expect(host).toContain('this.createGadget(blueprintId, title, viewer, "the agent", ip)');
  expect(host).toContain("this.#createCustomGadget(spec, viewer, ip)");
  expect(host).toContain('this.writeFile(id, path, content, viewer, "the agent", ip)');
  expect(workspace).toContain("meter(this.env).claimLoader(loaderId, ip)");
  expect(workspace).toContain("this.#ws.createGadget(blueprintId, title, this.#viewer, \"\", this.#ip)");
  expect(workspace).toContain("this.#ws.writeFile(id, path, content, this.#viewer, \"\", this.#ip)");
  expect(workspace).toContain("this.#ws.setBinding(id, binding, enabled, this.#viewer, this.#ip)");
});
