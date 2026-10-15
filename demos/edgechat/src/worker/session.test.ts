import { expect, test } from "bun:test";
import { COOKIE, loadSession, parseCookie, sanitizeName, sessionCookie } from "./session.ts";

test("wrangler.jsonc requires TURNSTILE_SECRET so deploy fails without it", async () => {
  const text = await Bun.file(new URL("../../wrangler.jsonc", import.meta.url)).text();
  expect(text).toContain('"required": ["TURNSTILE_SECRET"]');
});

test("loadSession helpers read only the cookie name", () => {
  expect(parseCookie("edgechat_sid=abc; other=1", COOKIE)).toBe("abc");
  expect(parseCookie("other=1", COOKIE)).toBeNull();
});

test("sanitizeName reserves EdgeChat and strips controls", () => {
  const reserved = sanitizeName("EdgeChat");
  expect(reserved.toLowerCase()).not.toBe("edgechat");
  expect(reserved.startsWith("Guest-")).toBe(true);
  expect(sanitizeName("Ann<script>")).toBe("Annscript");
});

test("loadSession ignores x-edgechat-session and only reads the cookie", async () => {
  const store = new Map<string, string>([
    [
      "session:cookie-id",
      JSON.stringify({ publicId: "pub-1", displayName: "Cookie User", createdAt: 1 }),
    ],
  ]);
  const env = {
    SESSIONS: {
      get: async (key: string) => {
        const raw = store.get(key);
        return raw ? JSON.parse(raw) : null;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    },
  } as unknown as Env;
  const fromHeader = await loadSession(
    env,
    new Request("http://127.0.0.1/", { headers: { "x-edgechat-session": "cookie-id" } }),
  );
  expect(fromHeader).toBeNull();
  const fromCookie = await loadSession(
    env,
    new Request("http://127.0.0.1/", { headers: { cookie: "edgechat_sid=cookie-id" } }),
  );
  expect(fromCookie?.displayName).toBe("Cookie User");
  expect(fromCookie?.publicId).toBe("pub-1");
});

test("loadSession rejects legacy KV records that have no publicId", async () => {
  const store = new Map<string, string>([
    ["session:old-cookie", JSON.stringify({ displayName: "Leaked", createdAt: 1 })],
  ]);
  const env = {
    SESSIONS: {
      get: async (key: string) => {
        const raw = store.get(key);
        return raw ? JSON.parse(raw) : null;
      },
      put: async () => {
        throw new Error("must not upgrade a leaked cookie");
      },
    },
  } as unknown as Env;
  const record = await loadSession(
    env,
    new Request("http://127.0.0.1/", { headers: { cookie: "edgechat_sid=old-cookie" } }),
  );
  expect(record).toBeNull();
});

test("loadSession rejects records whose publicId is empty", async () => {
  const store = new Map<string, string>([
    ["session:blank", JSON.stringify({ publicId: "", displayName: "Blank", createdAt: 1 })],
  ]);
  const env = {
    SESSIONS: {
      get: async (key: string) => {
        const raw = store.get(key);
        return raw ? JSON.parse(raw) : null;
      },
    },
  } as unknown as Env;
  const record = await loadSession(
    env,
    new Request("http://127.0.0.1/", { headers: { cookie: "edgechat_sid=blank" } }),
  );
  expect(record).toBeNull();
});

test("session cookie is HttpOnly, scoped, and Secure on https", () => {
  const hub = sessionCookie("sid-1", new Request("https://tech-demos.theserverless.dev/demos/edgechat/"));
  expect(hub).toContain("HttpOnly");
  expect(hub).toContain("Secure");
  expect(hub).toContain("Path=/demos/edgechat");
  const local = sessionCookie("sid-1", new Request("http://127.0.0.1:8787/"));
  expect(local).toContain("Path=/");
  expect(local).not.toContain("Secure");
});
