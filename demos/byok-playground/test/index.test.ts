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
