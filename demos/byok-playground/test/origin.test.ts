import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/worker/errors";
import { assertSameOrigin, isLocalRequest } from "../src/worker/origin";
import { mintSignedSession, readSessionParts, requireSession } from "../src/worker/session";

const env = { SESSION_SECRET: "test-session-secret" } as Env;

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

  test("does not allow the hub origin to call the playground origin", () => {
    const req = new Request("https://byok-playground.tech-demos.theserverless.dev/api/proxy/chat", {
      method: "POST",
      headers: { origin: "https://tech-demos.theserverless.dev" },
    });
    expect(() => assertSameOrigin(req)).toThrow(HttpError);
  });

  test("local wrangler rewritten host still accepts a localhost origin", () => {
    const req = new Request("https://tech-demos.theserverless.dev/demos/byok-playground/api/proxy/chat", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:8787", "cf-connecting-ip": "127.0.0.1" },
    });
    expect(isLocalRequest(req)).toBe(true);
    expect(() => assertSameOrigin(req)).not.toThrow();
  });

  test("proxy calls require an HMAC-signed session cookie", async () => {
    await expect(requireSession(new Request("https://example.com/api/proxy/chat"), env)).rejects.toBeInstanceOf(HttpError);
    const minted = await mintSignedSession(env, new Request("http://127.0.0.1:8787/"));
    expect(minted.cookie).toContain("byok_session=");
    expect(minted.cookie).toContain("HttpOnly");
    expect(minted.cookie).toContain("Max-Age=43200");
    const parts = readSessionParts(new Request("http://127.0.0.1:8787/", { headers: { cookie: minted.cookie.split(";")[0]! } }));
    expect(parts?.id).toBe(minted.id);
    expect(parts?.networkKey).toBe("local");
    expect(parts?.iat).toBeGreaterThan(0);
    const withCookie = new Request("http://127.0.0.1:8787/api/proxy/chat", { headers: { cookie: minted.cookie.split(";")[0]! } });
    expect(await requireSession(withCookie, env)).toBe(minted.id);
    const forged = new Request("http://127.0.0.1:8787/api/proxy/chat", {
      headers: { cookie: `byok_session=${minted.id}.${"ab".repeat(32)}` },
    });
    await expect(requireSession(forged, env)).rejects.toBeInstanceOf(HttpError);
  });

  test("expired sessions and network changes are rejected", async () => {
    const minted = await mintSignedSession(env, new Request("http://127.0.0.1:8787/", { headers: { "cf-connecting-ip": "203.0.113.9" } }), Date.now() - 13 * 60 * 60 * 1000);
    const cookie = minted.cookie.split(";")[0]!;
    const expired = new Request("http://127.0.0.1:8787/api/proxy/chat", { headers: { cookie, "cf-connecting-ip": "203.0.113.9" } });
    await expect(requireSession(expired, env)).rejects.toMatchObject({ code: "session_expired" });

    const fresh = await mintSignedSession(env, new Request("http://127.0.0.1:8787/", { headers: { "cf-connecting-ip": "203.0.113.9" } }));
    const moved = new Request("http://127.0.0.1:8787/api/proxy/chat", {
      headers: { cookie: fresh.cookie.split(";")[0]!, "cf-connecting-ip": "198.51.100.9" },
    });
    await expect(requireSession(moved, env)).rejects.toMatchObject({ code: "session_network" });
  });
});
