import { describe, expect, test } from "bun:test";
import { CANONICAL_HOST, HUB_BASE_PATH } from "../src/shared/limits";
import worker from "../src/worker/index";

function env(overrides: Partial<Env> = {}): Env {
  return {
    AI_MODEL: "@cf/meta/llama-3.2-1b-instruct",
    DAILY_COMPARE_CAP: "200",
    IP_COMPARE_CAP: "12",
    ENVIRONMENT: "",
    TURNSTILE_SITE_KEY: "REPLACE_ME",
    TURNSTILE_SECRET: "secret",
    IP_HASH_SECRET: "ip",
    SESSION_SECRET: "session",
    ASSETS: { fetch: async () => new Response("ok") },
    DB: {} as D1Database,
    CHAT_LIMIT: { limit: async () => ({ success: true }) },
    MODELS_LIMIT: { limit: async () => ({ success: true }) },
    COMPARE_LIMIT: { limit: async () => ({ success: true }) },
    SESSION_LIMIT: { limit: async () => ({ success: true }) },
    ...overrides,
  } as Env;
}

describe("canonical origin", () => {
  test("hub path 308s to the playground subdomain", async () => {
    const res = await worker.fetch(new Request(`https://tech-demos.theserverless.dev${HUB_BASE_PATH}/`), env(), {} as ExecutionContext);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`https://${CANONICAL_HOST}/`);
  });

  test("workers.dev 308s to the playground subdomain", async () => {
    const res = await worker.fetch(new Request("https://tech-demos-byok-playground.workers.dev/api/health"), env(), {} as ExecutionContext);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`https://${CANONICAL_HOST}/api/health`);
  });

  test("REPLACE_ME fails closed off localhost", async () => {
    const res = await worker.fetch(
      new Request("https://byok-playground.tech-demos.theserverless.dev/api/session", {
        method: "POST",
        headers: { origin: "https://byok-playground.tech-demos.theserverless.dev", "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: "{}",
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("turnstile_unconfigured");
    expect(body.error?.message).toContain("Proxy is off");
  });

  test("REPLACE_ME still mints on localhost when ENVIRONMENT is local", async () => {
    const res = await worker.fetch(
      new Request("http://127.0.0.1:8787/api/session", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:8787", "content-type": "application/json", "cf-connecting-ip": "127.0.0.1" },
        body: "{}",
      }),
      env({ ENVIRONMENT: "local" }),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(res.headers.get("set-cookie") ?? "").toContain("byok_session=");
  });

  test("session mint is rate-limited per network", async () => {
    const res = await worker.fetch(
      new Request("http://127.0.0.1:8787/api/session", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:8787", "content-type": "application/json", "cf-connecting-ip": "127.0.0.1" },
        body: "{}",
      }),
      env({ ENVIRONMENT: "local", SESSION_LIMIT: { limit: async () => ({ success: false }) } as Env["SESSION_LIMIT"] }),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(429);
  });

  test("ENVIRONMENT=local plus REPLACE_ME does not mint from a public IP", async () => {
    const res = await worker.fetch(
      new Request("https://byok-playground.tech-demos.theserverless.dev/api/session", {
        method: "POST",
        headers: { origin: "https://byok-playground.tech-demos.theserverless.dev", "content-type": "application/json", "cf-connecting-ip": "8.8.8.8" },
        body: "{}",
      }),
      env({ ENVIRONMENT: "local" }),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(503);
  });

  test("config reports session off when REPLACE_ME is deployed", async () => {
    const res = await worker.fetch(new Request("https://byok-playground.tech-demos.theserverless.dev/api/config"), env(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session?: string; siteKey?: string | null };
    expect(body.session).toBe("off");
    expect(body.siteKey).toBeNull();
  });

  test("local environment still serves the hub path", async () => {
    const res = await worker.fetch(
      new Request(`http://127.0.0.1:8787${HUB_BASE_PATH}/api/health`, { headers: { "cf-connecting-ip": "127.0.0.1" } }),
      env({ ENVIRONMENT: "local" }),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
