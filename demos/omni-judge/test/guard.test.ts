import { describe, expect, test } from "bun:test";
import { handleApi, HttpError } from "../src/worker/api";
import worker from "../src/worker/index";
import { acceptSiteverify } from "../src/worker/turnstile";

function env(limit: { judge?: boolean; read?: boolean } = {}): Env {
  return {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }), all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) }) },
    ENVIRONMENT: "local",
    IP_HASH_SECRET: "test-ip-secret",
    TURNSTILE_SECRET: "secret",
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    OMNI_MODEL: "@cf/cloudflare/clef-omni",
    CLEF_MODEL: "@cf/cloudflare/clef",
    WHISPER_MODEL: "@cf/openai/whisper-large-v3-turbo",
    VISION_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct",
    READ_LIMIT: { limit: async () => ({ success: limit.read !== false }) },
    JUDGE_LIMIT: { limit: async () => ({ success: limit.judge !== false }) },
    COMPARE_LIMIT: { limit: async () => ({ success: true }) },
    BUCKET: {},
    ASSETS: { fetch: async () => new Response("no", { status: 404 }) },
  } as unknown as Env;
}

async function post(path: string, init: RequestInit, binding = env()): Promise<Response> {
  try {
    return await handleApi(new Request(`http://127.0.0.1${path}`, init), binding, path);
  } catch (err) {
    if (err instanceof HttpError) return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    throw err;
  }
}

describe("request guards", () => {
  test("a judge POST without Content-Length is 411 before the body is read", async () => {
    const request = new Request("http://127.0.0.1/api/judge", { method: "POST", headers: { "content-type": "application/json" } });
    const response = await post("/api/judge", { method: "POST", headers: { "content-type": "application/json" }, body: request.body, duplex: "half" } as RequestInit);
    expect(response.status).toBe(411);
  });

  test("the judge rate limit runs before Turnstile siteverify", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("no", { status: 500 });
    }) as typeof fetch;
    try {
      const response = await post(
        "/api/judge",
        {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": "2" },
          body: "{}",
        },
        env({ judge: false }),
      );
      expect(response.status).toBe(429);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("health uses the read limit", async () => {
    const response = await post("/api/health", { method: "GET" }, env({ read: false }));
    expect(response.status).toBe(429);
  });

  test("the hub path redirects and the API stays on the demo host", async () => {
    const redirected = await worker.fetch(new Request("https://tech-demos.theserverless.dev/demos/omni-judge/api/judge"), env());
    expect(redirected.status).toBe(308);
    expect(redirected.headers.get("location")).toBe("https://omni-judge.tech-demos.theserverless.dev/api/judge");
    const blocked = await worker.fetch(new Request("https://example.com/api/health"), env());
    expect(blocked.status).toBe(503);
  });
});

describe("turnstile hostname", () => {
  test("action and hostname must match exactly", () => {
    expect(acceptSiteverify({ success: true, action: "judge", hostname: "omni-judge.tech-demos.theserverless.dev" }, "omni-judge.tech-demos.theserverless.dev")).toBe(true);
    expect(acceptSiteverify({ success: true, action: "other", hostname: "omni-judge.tech-demos.theserverless.dev" }, "omni-judge.tech-demos.theserverless.dev")).toBe(false);
    expect(acceptSiteverify({ success: true, hostname: "omni-judge.tech-demos.theserverless.dev" }, "omni-judge.tech-demos.theserverless.dev")).toBe(false);
    expect(acceptSiteverify({ success: true, action: "judge", hostname: "evil.theserverless.dev" }, "evil.theserverless.dev")).toBe(false);
    expect(acceptSiteverify({ success: true, action: "judge", hostname: "tech-demos.theserverless.dev" }, "tech-demos.theserverless.dev")).toBe(false);
  });
});
