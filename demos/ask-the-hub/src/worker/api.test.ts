import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { handleApi, MAX_BODY, type Deps } from "./api";
import { DAILY_CAP, capMessage, ensureCapSchema, rememberSql, searchCapMessage, takeSql, type CapSql } from "./cap";
import { DUMMY_TOKEN, TURNSTILE_ACTION, verifyTurnstile } from "./turnstile";

const QUESTION = "What does the R2 Drive demo prove?";

function siteverify(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

function sqlite(db: Database): CapSql {
  let lastWritten = 0;
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.query(query);
      const upper = query.trimStart().toUpperCase();
      if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
        const rows = statement.all(...(bindings as never[]));
        return { toArray: () => rows, get rowsWritten() { return lastWritten; } };
      }
      lastWritten = statement.run(...(bindings as never[])).changes;
      return { toArray: () => [], get rowsWritten() { return lastWritten; } };
    },
  };
}

function deps(over: Partial<Deps> = {}): Deps & {
  calls: { search: number; ask: number; claim: number; refund: number; refundSearch: number; limit: string[]; verify: number };
  clock: (ms: number) => void;
} {
  const calls = { search: 0, ask: 0, claim: 0, refund: 0, refundSearch: 0, limit: [] as string[], verify: 0 };
  const tokens = sqlite(new Database(":memory:"));
  ensureCapSchema(tokens);
  let now = 1_700_000_000_000;
  const base: Deps = {
    dev: false,
    siteKey: "0x4AAAAAAFRUoj5qDpf7XyIW",
    searchReady: true,
    async confirm() {
      return true;
    },
    async limit(name, key) {
      calls.limit.push(`${name}:${key}`);
      return true;
    },
    verify: (token, ip) => {
      calls.verify += 1;
      return verifyTurnstile({
        secret: "real-secret",
        token,
        ip,
        dev: false,
        fetchImpl: siteverify({ success: true, hostname: "tech-demos.theserverless.dev", action: TURNSTILE_ACTION }),
      });
    },
    async takeToken(hash) {
      return takeSql(tokens, hash, now);
    },
    async rememberToken(hash) {
      return rememberSql(tokens, hash, now);
    },
    async claim() {
      calls.claim += 1;
      return { ok: true, used: 1, remaining: 199, cap: DAILY_CAP, resetsAt: "2026-10-28T00:00:00.000Z" };
    },
    async claimSearch() {
      return { ok: true, used: 1, remaining: 999, cap: 1000, resetsAt: "2026-10-28T00:00:00.000Z" };
    },
    async refund() {
      calls.refund += 1;
    },
    async refundSearch() {
      calls.refundSearch += 1;
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
  return { ...base, ...over, calls, clock: (ms: number) => { now = ms; } };
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

test("DEV=1 accepts the dummy token and lets it be reused", async () => {
  const bag = deps({
    dev: true,
    verify: (token, ip) => verifyTurnstile({ secret: "1x0000000000000000000000000000000AA", token, ip, dev: true }),
  });
  const body = { question: QUESTION, turnstileToken: DUMMY_TOKEN };
  expect((await handleApi(post("/api/search", body), bag, "/api/search"))?.status).toBe(200);
  expect((await handleApi(post("/api/ask", body), bag, "/api/ask"))?.status).toBe(200);
  expect((await handleApi(post("/api/search", body), bag, "/api/search"))?.status).toBe(200);
});

test("search then ask share one token after the prune, and the third use is rejected", async () => {
  const bag = deps();
  const body = { question: QUESTION, turnstileToken: "site-token" };
  expect((await handleApi(post("/api/search", body), bag, "/api/search"))?.status).toBe(200);
  expect((await handleApi(post("/api/ask", body), bag, "/api/ask"))?.status).toBe(200);
  const third = await handleApi(post("/api/search", body), bag, "/api/search");
  expect(third?.status).toBe(403);
  expect(((await third!.json()) as { code: string }).code).toBe("turnstile");
  expect(bag.calls.verify).toBe(1);
});

test("a solved token can be used twice and the third replay is rejected", async () => {
  const bag = deps();
  const body = { question: QUESTION, turnstileToken: "site-token" };
  expect((await handleApi(post("/api/search", body), bag, "/api/search"))?.status).toBe(200);
  expect((await handleApi(post("/api/ask", body), bag, "/api/ask"))?.status).toBe(200);
  const third = await handleApi(post("/api/search", body), bag, "/api/search");
  expect(third?.status).toBe(403);
  expect(((await third!.json()) as { code: string }).code).toBe("turnstile");
  expect(bag.calls.verify).toBe(1);
});

test("a saved token is rejected after its original expiry", async () => {
  const bag = deps();
  const body = { question: QUESTION, turnstileToken: "site-token" };
  expect((await handleApi(post("/api/search", body), bag, "/api/search"))?.status).toBe(200);
  bag.clock(1_700_000_000_000 + 120_000);
  const again = await handleApi(post("/api/ask", body), bag, "/api/ask");
  expect(again?.status).toBe(403);
  expect(bag.calls.verify).toBe(1);
});

test("search over the daily cap returns a friendly 429", async () => {
  const bag = deps({
    claimSearch: async () => ({ ok: false, used: 1000, remaining: 0, cap: 1000, resetsAt: "2026-10-28T00:00:00.000Z" }),
  });
  const res = await handleApi(post("/api/search", { question: QUESTION, turnstileToken: "site-token" }), bag, "/api/search");
  expect(res?.status).toBe(429);
  const body = (await res!.json()) as { error: string; code: string };
  expect(body.code).toBe("daily_cap");
  expect(body.error).toBe(searchCapMessage(1000));
  expect(bag.calls.search).toBe(0);
});

test("an AI Search failure gives the ask slot back", async () => {
  const thrown = deps({
    aiSearch: async () => {
      throw new Error("down");
    },
  });
  const res = await handleApi(post("/api/ask", { question: QUESTION, turnstileToken: "site-token" }), thrown, "/api/ask");
  expect(res?.status).toBe(502);
  expect(thrown.calls.claim).toBe(1);
  expect(thrown.calls.refund).toBe(1);

  const bad = deps({
    aiSearch: async () => new Response("nope", { status: 500 }),
  });
  const failed = await handleApi(post("/api/ask", { question: QUESTION, turnstileToken: "site-token" }), bad, "/api/ask");
  expect(failed?.status).toBe(502);
  expect(bad.calls.refund).toBe(1);
});

test("a search failure gives the search slot back", async () => {
  const bag = deps({
    search: async () => {
      throw new Error("down");
    },
  });
  const res = await handleApi(post("/api/search", { question: QUESTION, turnstileToken: "site-token" }), bag, "/api/search");
  expect(res?.status).toBe(502);
  expect(bag.calls.refundSearch).toBe(1);
});

test("health is 503 until search is configured", async () => {
  const health = new Request("https://ask-the-hub.tech-demos.theserverless.dev/api/health");
  const down = await handleApi(health, deps({ searchReady: false }), "/api/health");
  expect(down?.status).toBe(503);
  const up = await handleApi(health, deps(), "/api/health");
  expect(up?.status).toBe(200);
  expect(((await up!.json()) as { ok: boolean }).ok).toBe(true);
});

test("health is 503 when the AI Search instance does not answer", async () => {
  const health = new Request("https://ask-the-hub.tech-demos.theserverless.dev/api/health");
  const down = await handleApi(health, deps({ confirm: async () => false }), "/api/health");
  expect(down?.status).toBe(503);
  expect(await down!.json()).toEqual({ ok: false, reason: "search_unavailable" });
});

test("a non-json or oversized body is refused before it is parsed", async () => {
  const bag = deps();
  const typed = new Request("https://ask-the-hub.tech-demos.theserverless.dev/api/ask", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ question: QUESTION, turnstileToken: "site-token" }),
  });
  const wrongType = await handleApi(typed, bag, "/api/ask");
  expect(wrongType?.status).toBe(400);
  expect(((await wrongType!.json()) as { code: string }).code).toBe("invalid_question");

  const tooBig = new Request("https://ask-the-hub.tech-demos.theserverless.dev/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "ok", turnstileToken: "site-token", pad: "x".repeat(MAX_BODY) }),
  });
  const oversized = await handleApi(tooBig, bag, "/api/ask");
  expect(oversized?.status).toBe(400);
  expect(bag.calls.verify).toBe(0);
  expect(bag.calls.claim).toBe(0);
});
