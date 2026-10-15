import { describe, expect, test } from "bun:test";
import { openContextPage } from "../src/worker/browse";
import { acquisitionsAllowed, authorizeSubresource, budgetDecision, completedPrivateResponse, createGuard, hashIpKey, network48, networkKey, rankSessions, sessionHasCapacity, sessionPrefix } from "../src/worker/policy";
import { authorizeNavigation, type Lookup } from "../src/worker/ssrf";

const SECRET = "test-ip-secret";

describe("B1 reuse", () => {
  test("ranks sessions newest startTime first and skips an empty id", () => {
    const ranked = rankSessions([
      { sessionId: "old", startTime: 10 },
      { sessionId: "", startTime: 99 },
      { sessionId: "new", startTime: 30 },
      { sessionId: "mid", startTime: 20 },
    ]);
    expect(ranked.map((session) => session.sessionId)).toEqual(["new", "mid", "old"]);
  });

  test("connects only when the measured context count is under the cap", () => {
    expect(sessionHasCapacity(0, 3)).toBe(true);
    expect(sessionHasCapacity(2, 3)).toBe(true);
    expect(sessionHasCapacity(3, 3)).toBe(false);
    expect(sessionHasCapacity(null, 3)).toBe(false);
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
    const cache = new Map<string, Promise<string[]>>();
    const first = await authorizeSubresource("https://evil.example/a.png", cache, lookup);
    const second = await authorizeSubresource("https://evil.example/frame", cache, lookup);
    const other = await authorizeSubresource("https://cdn.example/app.js", cache, lookup);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(other.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("https://h/ then http://h:8080/ must be blocked", async () => {
    let calls = 0;
    const lookup: Lookup = async () => {
      calls += 1;
      return ["1.1.1.1"];
    };
    const cache = new Map<string, Promise<string[]>>();
    const allowed = await authorizeSubresource("https://h.example/", cache, lookup);
    const blocked = await authorizeSubresource("http://h.example:8080/", cache, lookup);
    expect(allowed.ok).toBe(true);
    expect(blocked.ok).toBe(false);
    expect(calls).toBe(1);
    const literal = await authorizeSubresource("http://h:8080/", cache, lookup);
    expect(literal.ok).toBe(false);
    expect((await authorizeSubresource("https://h/", cache, lookup)).ok).toBe(false);
  });

  test("main-frame hops do not reuse the subresource DNS cache", async () => {
    let calls = 0;
    const lookup: Lookup = async () => {
      calls += 1;
      return ["1.1.1.1"];
    };
    expect((await authorizeNavigation("https://cdn.example/a", lookup)).ok).toBe(true);
    expect((await authorizeNavigation("https://cdn.example/b", lookup)).ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("a 65th distinct subresource host is aborted with no lookup", async () => {
    let calls = 0;
    const lookup: Lookup = async () => {
      calls += 1;
      return ["1.1.1.1"];
    };
    const cache = new Map<string, Promise<string[]>>();
    for (let i = 0; i < 64; i++) {
      const decision = await authorizeSubresource(`https://h${i}.example/`, cache, lookup);
      expect(decision.ok).toBe(true);
    }
    const extra = await authorizeSubresource("https://extra.example/", cache, lookup);
    expect(extra.ok).toBe(false);
    expect(calls).toBe(64);
    const again = await authorizeSubresource("https://h0.example/other", cache, lookup);
    expect(again.ok).toBe(true);
    expect(calls).toBe(64);
  });
});

describe("N1 popup guard", () => {
  test("targetcreated during newPage does not close the capture page, and a later popup does", async () => {
    type Target = { id: string; type: () => string; page: () => Promise<{ close: () => Promise<void> } | null> };
    const closed: string[] = [];
    const listeners: Array<(target: Target) => void> = [];
    const own: Target = {
      id: "own",
      type: () => "page",
      page: async () => ({
        close: async () => {
          closed.push("own");
        },
      }),
    };
    const context = {
      on(_event: "targetcreated", handler: (target: Target) => void) {
        listeners.push(handler);
      },
      async newPage() {
        for (const handler of [...listeners]) handler(own);
        return { target: () => own };
      },
    };
    const page = await openContextPage(context);
    expect(page.target()).toBe(own);
    expect(closed).toEqual([]);
    const popup: Target = {
      id: "popup",
      type: () => "page",
      page: async () => ({
        close: async () => {
          closed.push("popup");
        },
      }),
    };
    const other: Target = {
      id: "other-capture",
      type: () => "page",
      page: async () => ({
        close: async () => {
          closed.push("other-capture");
        },
      }),
    };
    for (const handler of listeners) handler(own);
    for (const handler of listeners) handler(popup);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toEqual(["popup"]);
    for (const handler of listeners) {
      handler({
        id: "worker",
        type: () => "worker",
        page: async () => ({
          close: async () => {
            closed.push("worker");
          },
        }),
      });
    }
    expect(listeners).toHaveLength(1);
    expect(other.id).toBe("other-capture");
    expect(closed).toEqual(["popup"]);
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

  test("network48 is the IPv6 /48 and the whole IPv4 address", () => {
    expect(network48("8.8.8.8")).toBe("8.8.8.8");
    expect(network48("2001:db8:85a3:1::1")).toBe("2001:db8:85a3::");
    expect(network48("2001:db8:85a3:ffff::9")).toBe("2001:db8:85a3::");
    expect(network48("2001:db8:85a4::1")).toBe("2001:db8:85a4::");
  });

  test("ip_key is an HMAC of the network key", async () => {
    const a = await hashIpKey("2001:db8:1:2::10", SECRET);
    const b = await hashIpKey("2001:db8:1:2:ffff::99", SECRET);
    const c = await hashIpKey("2001:db8:1:3::10", SECRET);
    const wide = await hashIpKey("2001:db8:1:2::10", SECRET, "48");
    const wideSame = await hashIpKey("2001:db8:1:ffff::1", SECRET, "48");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(wide).toBe(wideSame);
    expect(wide).not.toBe(a);
    expect(await hashIpKey("8.8.8.8", SECRET)).toBe(await hashIpKey("8.8.8.8", SECRET));
    expect(await hashIpKey("8.8.8.8", SECRET)).not.toBe(await hashIpKey("8.8.8.8", "other-secret"));
    await expect(hashIpKey("8.8.8.8", "")).rejects.toThrow(/IP_HASH_SECRET/);
  });

  test("cookie, network, /48, and daily caps", () => {
    expect(budgetDecision({ cookie: 0, network: 0, network48: 0, daily: 0 }).ok).toBe(true);
    const cookie = budgetDecision({ cookie: 6, network: 0, network48: 0, daily: 0 });
    expect(cookie.ok).toBe(false);
    if (!cookie.ok) expect(cookie.status).toBe(429);
    const network = budgetDecision({ cookie: 1, network: 6, network48: 0, daily: 10 });
    expect(network.ok).toBe(false);
    if (!network.ok) expect(network.message).toContain("6 captures");
    const wider = budgetDecision({ cookie: 1, network: 1, network48: 20, daily: 10 });
    expect(wider.ok).toBe(false);
    if (!wider.ok) expect(wider.message).toContain("20");
    const daily = budgetDecision({ cookie: 0, network: 0, network48: 0, daily: 300 });
    expect(daily.ok).toBe(false);
    if (!daily.ok) {
      expect(daily.status).toBe(503);
      expect(daily.message).toBe("daily budget used up");
    }
  });
});
