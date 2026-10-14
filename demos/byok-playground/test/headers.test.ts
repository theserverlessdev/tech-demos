import { describe, expect, test } from "bun:test";
import { KEY_HEADER } from "../src/shared/limits";
import { forwardedVisitorCookies, isHopByHop, outboundHeaders, sanitizeResponseHeaders } from "../src/worker/headers";

describe("header stripping", () => {
  test("never forwards cookies, hop-by-hop names, or the visitor key header", () => {
    const incoming = new Headers({
      cookie: "session=abc; byok_session=deadbeef",
      cookie2: "x",
      connection: "keep-alive, x-foo",
      "keep-alive": "timeout=5",
      "proxy-authorization": "Basic x",
      "x-forwarded-for": "8.8.8.8",
      forwarded: "for=8.8.8.8",
      authorization: "Bearer visitor-token",
      [KEY_HEADER]: "sk-real-secret-key",
      host: "evil.example",
      origin: "https://evil.example",
      referer: "https://evil.example/steal",
      "content-type": "application/json",
      "x-foo": "1",
    });
    expect(isHopByHop("cookie")).toBe(true);
    expect(isHopByHop("set-cookie")).toBe(true);
    expect(isHopByHop("connection")).toBe(true);
    expect(isHopByHop("keep-alive")).toBe(true);
    expect(isHopByHop("transfer-encoding")).toBe(true);
    expect(isHopByHop("upgrade")).toBe(true);
    expect(isHopByHop("te")).toBe(true);
    expect(isHopByHop("authorization")).toBe(true);
    expect(isHopByHop(KEY_HEADER)).toBe(true);
    expect(isHopByHop("x-foo", incoming)).toBe(true);
    expect(forwardedVisitorCookies(incoming)).toBe(true);
    expect(forwardedVisitorCookies(new Headers({ "content-type": "application/json" }))).toBe(false);
  });

  test("outbound headers are an allowlist with Bearer from the BYOK key", () => {
    const headers = outboundHeaders("sk-real-secret-key", "text/event-stream");
    expect(headers.get("authorization")).toBe("Bearer sk-real-secret-key");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("cookie2")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get(KEY_HEADER)).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "accept-encoding", "authorization", "content-type"]);
  });

  test("response sanitizer drops Set-Cookie and hop-by-hop, keeps content-type", () => {
    const upstream = new Headers({
      "set-cookie": "evil=1; Path=/",
      "set-cookie2": "evil=2",
      connection: "close",
      "transfer-encoding": "chunked",
      "keep-alive": "timeout=5",
      "content-type": "text/event-stream",
      "x-request-id": "should-drop",
      "content-security-policy": "should-drop",
    });
    const out = sanitizeResponseHeaders(upstream);
    expect(out.get("set-cookie")).toBeNull();
    expect(out.get("set-cookie2")).toBeNull();
    expect(out.get("connection")).toBeNull();
    expect(out.get("transfer-encoding")).toBeNull();
    expect(out.get("x-request-id")).toBeNull();
    expect(out.get("content-type")).toBe("text/event-stream");
    expect(out.get("cache-control")).toBe("no-store");
  });
});
