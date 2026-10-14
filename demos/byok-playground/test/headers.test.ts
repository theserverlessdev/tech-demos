import { describe, expect, test } from "bun:test";
import { apiHeaders, mimeType, outboundHeaders } from "../src/worker/headers";

describe("header allowlist", () => {
  test("outbound headers are an allowlist with Bearer from the BYOK key", () => {
    const headers = outboundHeaders("sk-real-secret-key", "text/event-stream");
    expect(headers.get("authorization")).toBe("Bearer sk-real-secret-key");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("cookie2")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("x-byok-key")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "accept-encoding", "authorization", "content-type"]);
  });

  test("API responses force content-type and a sandbox CSP", () => {
    const json = apiHeaders("json");
    expect(json.get("content-type")).toBe("application/json; charset=utf-8");
    expect(json.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    const sse = apiHeaders("sse");
    expect(sse.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(sse.get("cache-control")).toBe("no-store");
    expect(mimeType(new Headers({ "content-type": "text/event-stream; charset=utf-8" }))).toBe("text/event-stream");
  });
});
