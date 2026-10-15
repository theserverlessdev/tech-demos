import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/worker/errors";
import { assertSameOrigin, decodePathPart, isLocalRequest } from "../src/worker/origin";
import { cookiePath, mintSignedSession, readSessionParts, requireSession } from "../src/worker/session";

const env = { SESSION_SECRET: "test-session-secret" } as Env;

describe("same-origin and session cookie", () => {
  test("rejects a missing origin and a cross-origin POST", () => {
    const url = "https://resolve-hq.tech-demos.theserverless.dev/api/tickets/tkt_billing/draft";
    expect(() => assertSameOrigin(new Request(url, { method: "POST" }))).toThrow(HttpError);
    expect(() =>
      assertSameOrigin(new Request(url, { method: "POST", headers: { origin: "https://evil.example" } })),
    ).toThrow(HttpError);
    expect(() =>
      assertSameOrigin(new Request(url, { method: "POST", headers: { origin: "https://resolve-hq.tech-demos.theserverless.dev" } })),
    ).not.toThrow();
  });

  test("accepts Sec-Fetch-Site same-origin without an Origin header", () => {
    const req = new Request("https://resolve-hq.tech-demos.theserverless.dev/api/inbound", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(() => assertSameOrigin(req)).not.toThrow();
  });

  test("an Origin mismatch wins over a spoofed Sec-Fetch-Site", () => {
    const req = new Request("https://resolve-hq.tech-demos.theserverless.dev/api/inbound", {
      method: "POST",
      headers: { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
    });
    expect(() => assertSameOrigin(req)).toThrow(HttpError);
  });

  test("local wrangler rewritten host still accepts a localhost origin", () => {
    const req = new Request("https://tech-demos.theserverless.dev/demos/resolve-hq/api/inbound", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:8787", "cf-connecting-ip": "127.0.0.1" },
    });
    expect(isLocalRequest(req)).toBe(true);
    expect(() => assertSameOrigin(req)).not.toThrow();
  });

  test("session cookie is scoped to the hub demo path", async () => {
    expect(cookiePath(new Request("https://tech-demos.theserverless.dev/demos/resolve-hq/api/session"))).toBe("/demos/resolve-hq");
    expect(cookiePath(new Request("https://resolve-hq.tech-demos.theserverless.dev/api/session"))).toBe("/");
    const minted = await mintSignedSession(env, new Request("https://tech-demos.theserverless.dev/demos/resolve-hq/api/session"));
    expect(minted.cookie).toContain("Path=/demos/resolve-hq");
  });

  test("writes require an HMAC-signed session cookie", async () => {
    await expect(requireSession(new Request("https://example.com/api/inbound"), env)).rejects.toBeInstanceOf(HttpError);
    const minted = await mintSignedSession(env, new Request("http://127.0.0.1:8787/"));
    expect(minted.cookie).toContain("rhq_session=");
    expect(minted.cookie).toContain("HttpOnly");
    const parts = readSessionParts(new Request("http://127.0.0.1:8787/", { headers: { cookie: minted.cookie.split(";")[0]! } }));
    expect(parts?.id).toBe(minted.id);
    const withCookie = new Request("http://127.0.0.1:8787/api/inbound", { headers: { cookie: minted.cookie.split(";")[0]! } });
    expect(await requireSession(withCookie, env)).toBe(minted.id);
  });

  test("expired sessions and network changes are rejected", async () => {
    const minted = await mintSignedSession(
      env,
      new Request("http://127.0.0.1:8787/", { headers: { "cf-connecting-ip": "203.0.113.9" } }),
      Date.now() - 13 * 60 * 60 * 1000,
    );
    const cookie = minted.cookie.split(";")[0]!;
    const expired = new Request("http://127.0.0.1:8787/api/inbound", { headers: { cookie, "cf-connecting-ip": "203.0.113.9" } });
    await expect(requireSession(expired, env)).rejects.toMatchObject({ code: "session_expired" });

    const fresh = await mintSignedSession(env, new Request("http://127.0.0.1:8787/", { headers: { "cf-connecting-ip": "203.0.113.9" } }));
    const moved = new Request("http://127.0.0.1:8787/api/inbound", {
      headers: { cookie: fresh.cookie.split(";")[0]!, "cf-connecting-ip": "198.51.100.9" },
    });
    await expect(requireSession(moved, env)).rejects.toMatchObject({ code: "session_network" });
  });

  test("malformed percent-encoding is not a throw", () => {
    expect(decodePathPart("%E0%A4%A")).toBeNull();
    expect(decodePathPart("tkt_billing")).toBe("tkt_billing");
  });
});
