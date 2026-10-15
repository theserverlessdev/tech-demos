import { expect, test } from "bun:test";
import { assertContentLength, HttpError, isAllowedOrigin, safeDecode, stripEdgechatHeaders } from "./http.ts";

test("safeDecode rejects malformed percent-encoding", () => {
  expect(safeDecode("lobby")).toBe("lobby");
  expect(safeDecode("%E6%97%A5%E6%9C%AC%E8%AA%9E")).toBe("日本語");
  try {
    safeDecode("%E0%A4");
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).code).toBe("bad_path");
  }
});

test("isAllowedOrigin accepts the two live hosts and localhost", () => {
  const url = new URL("https://edgechat.tech-demos.theserverless.dev/ws/lobby");
  expect(isAllowedOrigin(null, url)).toBe(true);
  expect(isAllowedOrigin("https://edgechat.tech-demos.theserverless.dev", url)).toBe(true);
  expect(isAllowedOrigin("https://tech-demos.theserverless.dev", url)).toBe(true);
  expect(isAllowedOrigin("http://127.0.0.1:8787", url)).toBe(true);
  expect(isAllowedOrigin("https://evil.example", url)).toBe(false);
});

test("stripEdgechatHeaders drops incoming x-edgechat-*", () => {
  const headers = stripEdgechatHeaders(new Headers({ "x-edgechat-session": "stolen", cookie: "edgechat_sid=ok", "cf-connecting-ip": "1.2.3.4" }));
  expect(headers.get("x-edgechat-session")).toBeNull();
  expect(headers.get("cookie")).toBe("edgechat_sid=ok");
  expect(headers.get("cf-connecting-ip")).toBe("1.2.3.4");
});

test("assertContentLength rejects oversized Content-Length before a read", () => {
  const req = new Request("http://127.0.0.1/api", { method: "POST", headers: { "content-length": "999999" }, body: "x" });
  expect(() => assertContentLength(req, 16_000)).toThrow(HttpError);
});
