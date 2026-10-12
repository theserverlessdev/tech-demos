import { describe, expect, test } from "bun:test";
import { acquisitionsAllowed, budgetDecision, cachedAuthorize, completedPrivateResponse, createGuard, hashIpKey, networkKey, reusePlan, sessionPrefix } from "../src/worker/policy";
import type { Lookup } from "../src/worker/ssrf";

describe("B1 reuse", () => {
  test("launches a warm browser when nothing is listed", () => {
    expect(reusePlan([], null)).toBe("launch-warm");
    expect(reusePlan([""], 0)).toBe("launch-warm");
  });

  test("connects when the measured context count is under the cap", () => {
    expect(reusePlan(["abc12345ffff"], 0, 3)).toBe("connect");
    expect(reusePlan(["abc12345ffff"], 2, 3)).toBe("connect");
  });

  test("launches a one-off when the session is full or the count is unknown", () => {
    expect(reusePlan(["abc12345ffff"], 3, 3)).toBe("launch-one-off");
    expect(reusePlan(["abc12345ffff"], 8, 3)).toBe("launch-one-off");
    expect(reusePlan(["abc12345ffff"], null, 3)).toBe("launch-one-off");
  });

  test("refuses a launch when either limit is exhausted", () => {
    expect(acquisitionsAllowed({ allowedBrowserAcquisitions: 0, activeSessions: 0, maxConcurrentSessions: 10 })).toBe(false);
    expect(acquisitionsAllowed({ allowedBrowserAcquisitions: 3, activeSessions: 10, maxConcurrentSessions: 10 })).toBe(false);
    expect(acquisitionsAllowed({ allowedBrowserAcquisitions: 2, activeSessions: 1, maxConcurrentSessions: 10 })).toBe(true);
  });

  test("returns an 8 character session prefix", () => {
    expect(sessionPrefix("abcdef0123456789")).toBe("abcdef01");
    expect(sessionPrefix("short")).toBe("short");
  });
});

describe("B2 page guard", () => {
  test("a completed private response fails the capture, and a redirect with no IP does not", () => {
    expect(completedPrivateResponse(undefined, 200)).toBe(false);
    expect(completedPrivateResponse("", 200)).toBe(false);
    expect(completedPrivateResponse("", 302)).toBe(false);
    expect(completedPrivateResponse("1.1.1.1", 0)).toBe(false);
    expect(completedPrivateResponse("10.0.0.1", 302)).toBe(false);
    expect(completedPrivateResponse("10.0.0.1", 200)).toBe(true);
    expect(completedPrivateResponse("127.0.0.1", 404)).toBe(true);
    expect(completedPrivateResponse("1.1.1.1", 200)).toBe(false);

    const guard = createGuard();
    expect(guard.failure()).toBeNull();
    guard.noteResponse("", 302);
    guard.noteResponse(undefined, 200);
    expect(guard.failure()).toBeNull();
    guard.noteResponse("10.1.1.1", 200);
    expect(guard.failure()).toBe("The page connected to a blocked address.");
  });

  test("an aborted subresource does not fail the capture, and a blocked main frame does", () => {
    const guard = createGuard();
    guard.abortSubresource();
    expect(guard.failure()).toBeNull();
    guard.blockMain("That address is in a blocked range.");
    expect(guard.failure()).toBe("That address is in a blocked range.");
  });

  test("subresource DNS is cached per host and a private answer is not ok", async () => {
    let calls = 0;
    const lookup: Lookup = async (host) => {
      calls += 1;
      return host === "evil.example" ? ["10.0.0.8"] : ["1.1.1.1"];
    };
    const cache = new Map();
    const first = await cachedAuthorize(cache, "https://evil.example/a.png", lookup);
    const second = await cachedAuthorize(cache, "https://evil.example/frame", lookup);
    const other = await cachedAuthorize(cache, "https://cdn.example/app.js", lookup);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(other.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("B3 spend ceiling", () => {
  test("network key is the IPv4 or the IPv6 /64", () => {
    expect(networkKey("1.2.3.4")).toBe("1.2.3.4");
    expect(networkKey("2130706433")).toBe("127.0.0.1");
    expect(networkKey("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:85a3:0::");
    expect(networkKey("2001:db8:85a3:0:ffff::1")).toBe("2001:db8:85a3:0::");
    expect(networkKey("2001:db8:85a3:1::1")).toBe("2001:db8:85a3:1::");
    expect(networkKey("::ffff:8.8.8.8")).toBe("8.8.8.8");
    expect(networkKey("local")).toBe("local");
  });

  test("ip_key is a stable hash of the network key", async () => {
    const a = await hashIpKey("2001:db8:1:2::10");
    const b = await hashIpKey("2001:db8:1:2:ffff::99");
    const c = await hashIpKey("2001:db8:1:3::10");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashIpKey("8.8.8.8")).toBe(await hashIpKey("8.8.8.8"));
  });

  test("cookie, network, and daily caps", () => {
    expect(budgetDecision({ cookie: 0, network: 0, daily: 0 }).ok).toBe(true);
    const cookie = budgetDecision({ cookie: 6, network: 0, daily: 0 });
    expect(cookie.ok).toBe(false);
    if (!cookie.ok) expect(cookie.status).toBe(429);
    const network = budgetDecision({ cookie: 1, network: 6, daily: 10 });
    expect(network.ok).toBe(false);
    if (!network.ok) expect(network.message).toContain("network");
    const daily = budgetDecision({ cookie: 0, network: 0, daily: 300 });
    expect(daily.ok).toBe(false);
    if (!daily.ok) {
      expect(daily.status).toBe(503);
      expect(daily.message).toBe("daily budget used up");
    }
  });
});
