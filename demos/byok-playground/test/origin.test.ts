import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/worker/errors";
import { assertSameOrigin, isLocalRequest } from "../src/worker/origin";
import { requireSession, visitor } from "../src/worker/session";

describe("same-origin and session cookie", () => {
  test("rejects a missing origin and a cross-origin POST", () => {
    const url = "https://byok-playground.tech-demos.theserverless.dev/api/proxy/chat";
    expect(() => assertSameOrigin(new Request(url, { method: "POST" }))).toThrow(HttpError);
    expect(() =>
      assertSameOrigin(new Request(url, { method: "POST", headers: { origin: "https://evil.example" } })),
    ).toThrow(HttpError);
    expect(() =>
      assertSameOrigin(new Request(url, { method: "POST", headers: { origin: "https://byok-playground.tech-demos.theserverless.dev" } })),
    ).not.toThrow();
  });

  test("local wrangler rewritten host still accepts a localhost origin", () => {
    const req = new Request("https://tech-demos.theserverless.dev/demos/byok-playground/api/proxy/chat", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:8787", "cf-connecting-ip": "127.0.0.1" },
    });
    expect(isLocalRequest(req)).toBe(true);
    expect(() => assertSameOrigin(req)).not.toThrow();
  });

  test("proxy calls require the session cookie", () => {
    expect(() => requireSession(new Request("https://example.com/api/proxy/chat"))).toThrow(HttpError);
    const minted = visitor(new Request("http://127.0.0.1:8787/"));
    expect(minted.cookie).toContain("byok_session=");
    expect(minted.cookie).toContain("HttpOnly");
    const withCookie = new Request("http://127.0.0.1:8787/api/proxy/chat", { headers: { cookie: `byok_session=${minted.id}` } });
    expect(requireSession(withCookie)).toBe(minted.id);
  });
});
