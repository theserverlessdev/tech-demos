import { describe, expect, test } from "bun:test";
import { addressBlocked, assessUrl, authorizeNavigation, joinAllowedPath, type Lookup } from "../src/worker/ssrf";
import { HttpError } from "../src/worker/errors";

const publicDns: Lookup = async () => ["1.1.1.1"];

describe("address forms", () => {
  test("blocks decimal, hex, octal, and short IPv4", () => {
    expect(addressBlocked("2130706433")).toBe(true);
    expect(addressBlocked("0x7f000001")).toBe(true);
    expect(addressBlocked("0x7f.0x0.0x0.0x1")).toBe(true);
    expect(addressBlocked("0177.0.0.1")).toBe(true);
    expect(addressBlocked("127.1")).toBe(true);
    expect(addressBlocked("127.0.0.1")).toBe(true);
  });

  test("blocks IPv6 loopback, mapped, unique-local, and NAT64 forms", () => {
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

  test("blocks private, link-local, CGNAT, metadata, and broadcast ranges", () => {
    for (const host of ["10.1.2.3", "172.16.0.1", "192.168.1.20", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255", "192.0.2.1", "198.51.100.1", "203.0.113.1"]) {
      expect(addressBlocked(host)).toBe(true);
    }
    expect(addressBlocked("100.128.0.1")).toBe(false);
    expect(addressBlocked("172.15.0.1")).toBe(false);
  });
});

describe("assessUrl", () => {
  test("rejects non-https schemes, userinfo, internal names, and odd ports", () => {
    expect(assessUrl("file:///etc/passwd").ok).toBe(false);
    expect(assessUrl("javascript:alert(1)").ok).toBe(false);
    expect(assessUrl("http://example.com/").ok).toBe(false);
    expect(assessUrl("https://user:pass@example.com/").ok).toBe(false);
    expect(assessUrl("https://localhost/").ok).toBe(false);
    expect(assessUrl("http://localhost/").ok).toBe(false);
    expect(assessUrl("https://metadata.google.internal/").ok).toBe(false);
    expect(assessUrl("https://printer.local/").ok).toBe(false);
    expect(assessUrl("https://router/").ok).toBe(false);
    expect(assessUrl("https://example.com:22/").ok).toBe(false);
    expect(assessUrl("https://127.0.0.1/").ok).toBe(false);
    expect(assessUrl("https://[::1]/").ok).toBe(false);
    expect(assessUrl("https://2130706433/").ok).toBe(false);
    expect(assessUrl("https://0x7f000001/").ok).toBe(false);
    expect(assessUrl("https://[::ffff:7f00:1]/").ok).toBe(false);
    expect(assessUrl("https://nas.home.arpa/").ok).toBe(false);
    expect(assessUrl("https://printer.lan/").ok).toBe(false);
    expect(assessUrl("https://files.intranet/").ok).toBe(false);
    expect(assessUrl("https://dc.corp/").ok).toBe(false);
    expect(assessUrl("https://1.2.3.4.in-addr.arpa/").ok).toBe(false);
  });

  test("accepts a public https URL without resolving it", () => {
    const decision = assessUrl("https://api.openai.com/v1");
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.url).toContain("https://api.openai.com/v1");
  });

  test("allows http://localhost only when wrangler-dev flag is on", () => {
    expect(assessUrl("http://localhost:8799/v1").ok).toBe(false);
    expect(assessUrl("http://127.0.0.1:8799/v1").ok).toBe(false);
    expect(assessUrl("http://localhost:8799/v1", { allowLocalhost: true }).ok).toBe(true);
    expect(assessUrl("http://127.0.0.1:8799/v1", { allowLocalhost: true }).ok).toBe(true);
    expect(assessUrl("http://[::1]:8799/v1", { allowLocalhost: true }).ok).toBe(true);
    expect(assessUrl("http://169.254.169.254/", { allowLocalhost: true }).ok).toBe(false);
    expect(assessUrl("http://10.0.0.5/", { allowLocalhost: true }).ok).toBe(false);
    expect(assessUrl("http://example.com/", { allowLocalhost: true }).ok).toBe(false);
  });
});

describe("dns", () => {
  test("blocks a hostname whose DNS answer is private", async () => {
    const decision = await authorizeNavigation("https://public.example/v1", async () => ["10.0.0.5", "1.1.1.1"]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("ssrf");
  });

  test("allows a public DNS answer", async () => {
    const decision = await authorizeNavigation("https://api.openai.com/v1", publicDns);
    expect(decision.ok).toBe(true);
  });

  test("skips DNS for localhost under wrangler dev", async () => {
    let called = 0;
    const lookup: Lookup = async () => {
      called += 1;
      return ["1.1.1.1"];
    };
    const decision = await authorizeNavigation("http://127.0.0.1:8799/v1", lookup, { allowLocalhost: true });
    expect(decision.ok).toBe(true);
    expect(called).toBe(0);
  });
});

describe("path allowlist", () => {
  test("joins /chat/completions and /models under the base", () => {
    expect(joinAllowedPath("https://api.openai.com/v1", "/chat/completions")).toBe("https://api.openai.com/v1/chat/completions");
    expect(joinAllowedPath("https://api.openai.com/v1/", "/models")).toBe("https://api.openai.com/v1/models");
  });

  test("rejects a suffix that is not allowlisted", () => {
    expect(() => joinAllowedPath("https://api.openai.com/v1", "/admin" as "/models")).toThrow(HttpError);
  });
});
