import { expect, test } from "bun:test";
import { errorResponse, handleApi } from "../src/worker/api";
import { spendUsed } from "../src/worker/db";
import { hashIp } from "../src/worker/ip";
import { asD1, memoryDb } from "./helpers";

const HOST = "clairic-intake.tech-demos.theserverless.dev";
const IP = "203.0.113.9";
const SECRET = "ip-hash-secret";
const previousFetch = globalThis.fetch;

function limit() {
  return { async limit() { return { success: true }; } };
}

function env(action: "extract" | "decide"): Env {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("siteverify")) {
      return new Response(JSON.stringify({ success: true, hostname: HOST, action }), { status: 200 });
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  return {
    ENVIRONMENT: "hosted",
    TURNSTILE_SECRET: "not-the-dummy-secret",
    TURNSTILE_SITE_KEY: "site-key",
    IP_HASH_SECRET: SECRET,
    CLAIRIC_MODEL: "@cf/cloudflare/clairic",
    COMPARE_MODEL: "@cf/meta/llama-3.2-3b-instruct",
    CLEF_MODEL: "@cf/cloudflare/clef",
    DB: asD1(memoryDb()),
    AI: { async run() { throw new Error("model_down"); } },
    EXTRACT_LIMIT: limit(),
    COMPARE_LIMIT: limit(),
    DECIDE_LIMIT: limit(),
    BATCH_LIMIT: limit(),
    UPLOAD_LIMIT: limit(),
    READ_LIMIT: limit(),
    REVIEW_LIMIT: limit(),
  } as unknown as Env;
}

function post(path: string, body: unknown): Request {
  return new Request(`https://${HOST}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": IP },
    body: JSON.stringify(body),
  });
}

async function call(request: Request, worker: Env, path: string): Promise<Response> {
  try {
    return await handleApi(request, worker, path);
  } catch (err) {
    return errorResponse(err);
  }
}

test("extract and decide refund the reserved calls when the model fails", async () => {
  try {
    const extractEnv = env("extract");
    const extract = await call(
      post("/api/extract", {
        turnstileToken: "token",
        state: "Invoice from Ada for 10 USD.",
        fields: { vendor: { type: "text", instructions: "Who billed this" } },
      }),
      extractEnv,
      "/api/extract",
    );
    expect(extract.status).toBe(502);
    const ipKey = await hashIp(IP, SECRET);
    expect(await spendUsed(extractEnv.DB, ipKey, Date.now())).toBe(0);

    const decideEnv = env("decide");
    const decide = await call(
      post("/api/decide", {
        turnstileToken: "token",
        fields: { vendor: { type: "text", instructions: "Who billed this" } },
        answers: { vendor: { type: "text", value: "Ada" } },
      }),
      decideEnv,
      "/api/decide",
    );
    expect(decide.status).toBe(502);
    expect(await spendUsed(decideEnv.DB, ipKey, Date.now())).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
