import { expect, test } from "bun:test";
import { handleApi, type Deps } from "./api";
import { DAILY_CAP, capMessage } from "./cap";
import { DUMMY_TOKEN, verifyTurnstile } from "./turnstile";

const QUESTION = "What does the R2 Drive demo prove?";

function siteverify(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

function deps(over: Partial<Deps> = {}): Deps & { calls: { search: number; ask: number; claim: number; limit: string[] } } {
  const calls = { search: 0, ask: 0, claim: 0, limit: [] as string[] };
  const base: Deps = {
    dev: false,
    siteKey: "0x4AAAAAAFRUoj5qDpf7XyIW",
    async limit(name, key) {
      calls.limit.push(`${name}:${key}`);
      return true;
    },
    verify: (token, ip) =>
      verifyTurnstile({
        secret: "real-secret",
        token,
        ip,
        dev: false,
        fetchImpl: siteverify({ success: true, hostname: "tech-demos.theserverless.dev" }),
      }),
    async knownToken() {
      return false;
    },
    async noteToken() {},
    async claim() {
      calls.claim += 1;
      return { ok: true, used: 1, remaining: 199, cap: DAILY_CAP, resetsAt: "2026-10-28T00:00:00.000Z" };
    },
    async search() {
      calls.search += 1;
      return [{ source: "r2-drive/README.md", score: 0.91, snippet: "WebDAV on Workers." }];
    },
    async aiSearch() {
      calls.ask += 1;
      return new Response('data: {"response":"It is a WebDAV drive."}\n\n', {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  };
  return { ...base, ...over, calls };
}

function post(path: string, body: unknown, ip = "203.0.113.10") {
  return new Request(`https://ask-the-hub.tech-demos.theserverless.dev${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://tech-demos.theserverless.dev",
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify(body),
  });
}

test("search returns chunks and ask streams", async () => {
  const bag = deps();
  const found = await handleApi(post("/api/search", { question: `  ${QUESTION}  `, turnstileToken: "site-token" }), bag, "/api/search");
  expect(found?.status).toBe(200);
  const payload = (await found!.json()) as { chunks: { source: string; score: number }[] };
  expect(payload.chunks[0]?.source).toBe("r2-drive/README.md");
  expect(payload.chunks[0]?.score).toBe(0.91);
  expect(bag.calls.claim).toBe(0);

  const asked = await handleApi(post("/api/ask", { question: QUESTION, turnstileToken: "site-token" }), bag, "/api/ask");
  expect(asked?.status).toBe(200);
  expect(asked?.headers.get("content-type")).toContain("text/event-stream");
  expect(await asked!.text()).toContain("WebDAV");
  expect(bag.calls.claim).toBe(1);
  expect(bag.calls.limit[0]).toBe("SEARCH_LIMIT:203.0.113.10");
});

test("empty, blank, and long questions are refused", async () => {
  const bag = deps();
  const empty = await handleApi(post("/api/ask", { question: "   ", turnstileToken: "site-token" }), bag, "/api/ask");
  expect(empty?.status).toBe(400);
  const missing = await handleApi(post("/api/ask", { turnstileToken: "site-token" }), bag, "/api/ask");
  expect(missing?.status).toBe(400);
  const long = await handleApi(post("/api/ask", { question: "a".repeat(501), turnstileToken: "site-token" }), bag, "/api/ask");
  expect(long?.status).toBe(400);
  expect(((await long!.json()) as { error: string }).error).toBe("Keep the question to 500 characters.");
  expect(bag.calls.ask).toBe(0);
  expect(bag.calls.claim).toBe(0);
});

test("a per-IP rate limit returns 429 before the cap", async () => {
  const bag = deps({
    limit: async () => false,
  });
  const res = await handleApi(post("/api/ask", { question: QUESTION, turnstileToken: "site-token" }), bag, "/api/ask");
  expect(res?.status).toBe(429);
  const body = (await res!.json()) as { code: string; error: string };
  expect(body.code).toBe("rate_limit");
  expect(body.error).toContain("Try again shortly");
  expect(bag.calls.claim).toBe(0);
});

test("the daily cap returns a midnight UTC message", async () => {
  const bag = deps({
    claim: async () => ({ ok: false, used: 200, remaining: 0, cap: 200, resetsAt: "2026-10-28T00:00:00.000Z" }),
  });
  const res = await handleApi(post("/api/ask", { question: QUESTION, turnstileToken: "site-token" }), bag, "/api/ask");
  expect(res?.status).toBe(429);
  const body = (await res!.json()) as { code: string; error: string; resetsAt: string };
  expect(body.code).toBe("daily_cap");
  expect(body.error).toBe(capMessage(200));
  expect(body.resetsAt).toBe("2026-10-28T00:00:00.000Z");
  expect(bag.calls.ask).toBe(0);
});

test("missing, bad, and localhost tokens are rejected in production", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  };
  try {
    const missing = deps();
    const missingRes = await handleApi(post("/api/ask", { question: QUESTION }), missing, "/api/ask");
    expect(missingRes?.status).toBe(403);
    expect(((await missingRes!.json()) as { code: string }).code).toBe("missing_token");

    const bad = deps({
      verify: (token, ip) =>
        verifyTurnstile({
          secret: "real-secret",
          token,
          ip,
          dev: false,
          fetchImpl: siteverify({ success: false }),
        }),
    });
    const badRes = await handleApi(post("/api/ask", { question: QUESTION, turnstileToken: "nope" }), bad, "/api/ask");
    expect(badRes?.status).toBe(403);
    expect(((await badRes!.json()) as { code: string }).code).toBe("turnstile");

    const local = deps({
      verify: (token, ip) =>
        verifyTurnstile({
          secret: "real-secret",
          token,
          ip,
          dev: false,
          fetchImpl: siteverify({ success: true, hostname: "localhost" }),
        }),
    });
    const localRes = await handleApi(
      post("/api/ask", { question: QUESTION, turnstileToken: "site-token" }),
      local,
      "/api/ask",
    );
    expect(localRes?.status).toBe(403);

    const dummy = deps({
      verify: (token, ip) =>
        verifyTurnstile({
          secret: "real-secret",
          token,
          ip,
          dev: false,
          fetchImpl: siteverify({ success: true, hostname: "example.com" }),
        }),
    });
    const dummyRes = await handleApi(
      post("/api/search", { question: QUESTION, turnstileToken: DUMMY_TOKEN }),
      dummy,
      "/api/search",
    );
    expect(dummyRes?.status).toBe(403);
    expect(logs.join("\n")).not.toContain(QUESTION);
  } finally {
    console.log = original;
  }
});

test("DEV=1 accepts the dummy token", async () => {
  const bag = deps({
    dev: true,
    verify: (token, ip) => verifyTurnstile({ secret: "1x0000000000000000000000000000000AA", token, ip, dev: true }),
  });
  const res = await handleApi(post("/api/search", { question: QUESTION, turnstileToken: DUMMY_TOKEN }), bag, "/api/search");
  expect(res?.status).toBe(200);
});
