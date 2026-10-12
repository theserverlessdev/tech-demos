import { describe, expect, test } from "bun:test";
import { addressBlocked, assessUrl, authorizeChain, authorizeNavigation, type Lookup } from "../src/worker/ssrf";

const publicDns: Lookup = async () => ["1.1.1.1"];

function scripted(answers: Record<string, string[][]>): Lookup {
  const seen = new Map<string, number>();
  return async (host: string) => {
    const list = answers[host];
    if (!list) return ["1.1.1.1"];
    const index = seen.get(host) ?? 0;
    seen.set(host, index + 1);
    return list[Math.min(index, list.length - 1)] ?? [];
  };
}

describe("address forms", () => {
  test("blocks decimal, hex, octal, and short IPv4", () => {
    expect(addressBlocked("2130706433")).toBe(true);
    expect(addressBlocked("0x7f000001")).toBe(true);
    expect(addressBlocked("0x7f.0x0.0x0.0x1")).toBe(true);
    expect(addressBlocked("0177.0.0.1")).toBe(true);
    expect(addressBlocked("127.1")).toBe(true);
    expect(addressBlocked("127.0.0.1")).toBe(true);
  });

  test("blocks IPv6 loopback, mapped, and unique-local forms", () => {
    expect(addressBlocked("::1")).toBe(true);
    expect(addressBlocked("::")).toBe(true);
    expect(addressBlocked("::ffff:127.0.0.1")).toBe(true);
    expect(addressBlocked("::ffff:0:127.0.0.1")).toBe(true);
    expect(addressBlocked("::ffff:0:7f00:1")).toBe(true);
    expect(addressBlocked("::ffff:0:8.8.8.8")).toBe(true);
    expect(addressBlocked("::ffff:7f00:1")).toBe(true);
    expect(addressBlocked("[::ffff:127.0.0.1]")).toBe(true);
    expect(addressBlocked("::7f00:1")).toBe(true);
    expect(addressBlocked("fd00::1")).toBe(true);
    expect(addressBlocked("fe80::1")).toBe(true);
    expect(addressBlocked("64:ff9b::7f00:1")).toBe(true);
    expect(addressBlocked("2002:7f00:1::")).toBe(true);
  });

  test("allows a public address and ignores hostnames", () => {
    expect(addressBlocked("1.1.1.1")).toBe(false);
    expect(addressBlocked("8.8.8.8")).toBe(false);
    expect(addressBlocked("64:ff9b::808:808")).toBe(false);
    expect(addressBlocked("2001:4860:4860::8888")).toBe(false);
    expect(addressBlocked("example.com")).toBe(null);
  });

  test("blocks private, link-local, CGNAT, and metadata ranges", () => {
    for (const host of ["10.1.2.3", "172.16.0.1", "192.168.1.20", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255"]) {
      expect(addressBlocked(host)).toBe(true);
    }
    expect(addressBlocked("100.128.0.1")).toBe(false);
    expect(addressBlocked("172.15.0.1")).toBe(false);
  });
});

describe("assessUrl", () => {
  test("rejects non-http schemes, userinfo, internal names, and odd ports", () => {
    expect(assessUrl("file:///etc/passwd").ok).toBe(false);
    expect(assessUrl("javascript:alert(1)").ok).toBe(false);
    expect(assessUrl("http://user:pass@example.com/").ok).toBe(false);
    expect(assessUrl("http://localhost/").ok).toBe(false);
    expect(assessUrl("http://metadata.google.internal/").ok).toBe(false);
    expect(assessUrl("http://printer.local/").ok).toBe(false);
    expect(assessUrl("http://router/").ok).toBe(false);
    expect(assessUrl("https://example.com:22/").ok).toBe(false);
    expect(assessUrl("http://127.0.0.1/").ok).toBe(false);
    expect(assessUrl("http://[::1]/").ok).toBe(false);
    expect(assessUrl("http://2130706433/").ok).toBe(false);
    expect(assessUrl("http://0x7f000001/").ok).toBe(false);
    expect(assessUrl("http://[::ffff:7f00:1]/").ok).toBe(false);
    expect(assessUrl("http://[::ffff:0:127.0.0.1]/").ok).toBe(false);
    expect(assessUrl("http://[::ffff:0:8.8.8.8]/").ok).toBe(false);
    expect(assessUrl("http://nas.home.arpa/").ok).toBe(false);
    expect(assessUrl("http://printer.lan/").ok).toBe(false);
    expect(assessUrl("http://files.intranet/").ok).toBe(false);
    expect(assessUrl("http://dc.corp/").ok).toBe(false);
    expect(assessUrl("http://1.2.3.4.in-addr.arpa/").ok).toBe(false);
  });

  test("accepts a public https URL without resolving it", () => {
    const decision = assessUrl("https://example.com/docs");
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.url).toBe("https://example.com/docs");
  });
});

describe("dns and redirects", () => {
  test("blocks a hostname whose DNS answer is private", async () => {
    const decision = await authorizeNavigation("https://public.example/a", async () => ["10.0.0.5", "1.1.1.1"]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("ssrf");
  });

  test("blocks a redirect onto a literal metadata address", async () => {
    const decision = await authorizeChain(["https://example.com/start", "http://169.254.169.254/latest"], publicDns);
    expect(decision.ok).toBe(false);
  });

  test("blocks a redirect onto a decimal and a hex loopback", async () => {
    expect((await authorizeChain(["https://example.com/", "http://2130706433/"], publicDns)).ok).toBe(false);
    expect((await authorizeChain(["https://example.com/", "http://0x7f000001/"], publicDns)).ok).toBe(false);
    expect((await authorizeChain(["https://example.com/", "http://[::ffff:127.0.0.1]/"], publicDns)).ok).toBe(false);
  });

  test("treats a second lookup of the redirect target as a new resolution", async () => {
    const lookup = scripted({ "rebind.example": [["1.1.1.1"], ["127.0.0.1"]] });
    const decision = await authorizeChain(["https://rebind.example/start", "https://rebind.example/next"], lookup);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message).toContain("blocked");
  });

  test("allows a public redirect chain", async () => {
    const decision = await authorizeChain(["https://example.com/a", "https://theserverless.dev/b"], publicDns);
    expect(decision.ok).toBe(true);
  });
});
