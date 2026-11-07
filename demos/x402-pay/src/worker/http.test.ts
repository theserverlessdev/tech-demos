import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GLOBAL_PAID_CAP, NETWORK, SESSION_PAID_CAP, SQUARE_ATOMIC, SUMMARY_ATOMIC, USDC_BASE_SEPOLIA, USDC_NAME, USDC_VERSION } from "../shared/protocol";
import { HttpError, handleApi, type Deps } from "./http";
import type { ToolView } from "./interpret";
import type { Sql } from "./sql";
import { DUMMY_TOKEN, verifyTurnstile } from "./turnstile";

const PAYEE = "0x2222222222222222222222222222222222222222";
const migration = readFileSync(new URL("../../migrations/0001_ledger.sql", import.meta.url), "utf8");

function memory(): Sql {
  const db = new Database(":memory:");
  db.exec(migration);
  return {
    async run(query, params = []) {
      const result = db.query(query).run(...(params as never[]));
      return Number(result.changes ?? 0);
    },
    async get<T extends Record<string, unknown>>(query, params = []) {
      return (db.query(query).get(...(params as never[])) as T | null) ?? null;
    },
    async all<T extends Record<string, unknown>>(query, params = []) {
      return db.query(query).all(...(params as never[])) as T[];
    },
  };
}

function challenge(amount: string, payee = PAYEE, network = NETWORK): Record<string, unknown> {
  return {
    scheme: "exact",
    network,
    asset: USDC_BASE_SEPOLIA,
    amount,
    payTo: payee,
    maxTimeoutSeconds: 120,
    extra: { name: USDC_NAME, version: USDC_VERSION },
  };
}

function view(partial: Partial<ToolView>): ToolView {
  return {
    text: "",
    isError: false,
    setup: false,
    challenge: null,
    success: false,
    transaction: "",
    network: "",
    code: "",
    ...partial,
  };
}

function harness(opts?: {
  mode?: Deps["mode"];
  payee?: string;
  now?: number;
  probe?: Deps["probe"];
  pay?: Deps["pay"];
  limit?: Deps["limit"];
}): { deps: Deps; settles: { n: number }; clock: { now: number } } {
  const clock = { now: opts?.now ?? Date.UTC(2026, 10, 7, 12, 0, 0) };
  const settles = { n: 0 };
  const mode = opts?.mode ?? "testnet";
  const payee = opts?.payee ?? PAYEE;
  const deps: Deps = {
    sql: memory(),
    now: () => clock.now,
    local: true,
    mode,
    payee,
    siteKey: "1x00000000000000000000AA",
    verify: async (token) => (token === DUMMY_TOKEN ? "ok" : "rejected"),
    limit: opts?.limit ?? (async () => true),
    probe: opts?.probe ?? (async (_session, tool, args) => {
      if (tool === "echo") return view({ text: String(args.message ?? "") });
      const amount = tool === "summarize" ? SUMMARY_ATOMIC : SQUARE_ATOMIC;
      return view({ isError: true, challenge: challenge(amount, payee) });
    }),
    pay: opts?.pay ?? (async (_session, tool, args) => {
      settles.n += 1;
      const text = tool === "square" ? String(Number(args.number) ** 2) : "A short summary.";
      return view({ text, success: true, transaction: "0x" + "ab".repeat(32), network: NETWORK });
    }),
  };
  return { deps, settles, clock };
}

async function api(request: Request, deps: Deps, path: string): Promise<Response> {
  try {
    return await handleApi(request, deps, path, "");
  } catch (err) {
    if (err instanceof HttpError) {
      return Response.json({ paid: false, error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
}

async function session(deps: Deps): Promise<string> {
  const response = await api(new Request("https://x402-pay.tech-demos.theserverless.dev/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnstileToken: DUMMY_TOKEN }),
  }), deps, "/api/session");
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  const token = cookie.match(/x402_session=([^;]+)/)?.[1] ?? "";
  expect(token.length).toBeGreaterThan(10);
  return `x402_session=${token}`;
}

function call(deps: Deps, cookie: string, body: unknown): Promise<Response> {
  return api(new Request("https://x402-pay.tech-demos.theserverless.dev/api/call", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  }), deps, "/api/call");
}

function confirm(deps: Deps, cookie: string, body: unknown): Promise<Response> {
  return api(new Request("https://x402-pay.tech-demos.theserverless.dev/api/confirm", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  }), deps, "/api/confirm");
}

test("echo is free and does not settle", async () => {
  const { deps, settles } = harness();
  const cookie = await session(deps);
  const response = await call(deps, cookie, { tool: "echo", args: { message: "hello" } });
  const body = await response.json() as { paid: boolean; text: string };
  expect(response.status).toBe(200);
  expect(body.paid).toBe(false);
  expect(body.text).toBe("hello");
  expect(settles.n).toBe(0);
});

test("a paid call returns HTTP 402 and confirm settles once", async () => {
  const { deps, settles } = harness();
  const cookie = await session(deps);
  const challenged = await call(deps, cookie, { tool: "square", args: { number: 4 } });
  const challengeBody = await challenged.json() as { paid: boolean; status: string; confirmationId: string; binding: string; challenge: { network: string; amount: string; payTo: string } };
  expect(challenged.status).toBe(402);
  expect(challengeBody.paid).toBe(false);
  expect(challengeBody.status).toBe("requested");
  expect(challengeBody.challenge.network).toBe(NETWORK);
  expect(challengeBody.challenge.amount).toBe(SQUARE_ATOMIC);
  expect(challengeBody.challenge.payTo).toBe(PAYEE);
  expect(settles.n).toBe(0);

  const denied = await confirm(deps, cookie, { confirmationId: challengeBody.confirmationId, binding: challengeBody.binding, accept: false });
  const deniedBody = await denied.json() as { paid: boolean; status: string };
  expect(deniedBody.paid).toBe(false);
  expect(deniedBody.status).toBe("denied");
  expect(settles.n).toBe(0);

  const again = await call(deps, cookie, { tool: "square", args: { number: 4 } });
  const second = await again.json() as { confirmationId: string; binding: string };
  const paid = await confirm(deps, cookie, { confirmationId: second.confirmationId, binding: second.binding, accept: true });
  const paidBody = await paid.json() as { paid: boolean; status: string; settlement: string; text: string; transaction: string };
  expect(paid.status).toBe(200);
  expect(paidBody.paid).toBe(true);
  expect(paidBody.status).toBe("settled");
  expect(paidBody.settlement).toBe("testnet");
  expect(paidBody.text).toBe("16");
  expect(paidBody.transaction.startsWith("0x")).toBe(true);
  expect(settles.n).toBe(1);

  const replay = await confirm(deps, cookie, { confirmationId: second.confirmationId, binding: second.binding, accept: true });
  const replayBody = await replay.json() as { paid: boolean; transaction: string; status: string };
  expect(replayBody.status).toBe("settled");
  expect(replayBody.transaction).toBe(paidBody.transaction);
  expect(settles.n).toBe(1);
});

test("unapproved, expired, altered, wrong-chain, and foreign sessions do not settle", async () => {
  const { deps, settles, clock } = harness();
  const cookie = await session(deps);
  const other = await session(deps);
  const challenged = await call(deps, cookie, { tool: "square", args: { number: 9 } });
  const body = await challenged.json() as { confirmationId: string; binding: string };
  expect(challenged.status).toBe(402);

  const wrongBinding = await confirm(deps, cookie, { confirmationId: body.confirmationId, binding: "0".repeat(64), accept: true });
  expect(wrongBinding.status).toBe(403);
  expect(settles.n).toBe(0);

  const foreign = await confirm(deps, other, { confirmationId: body.confirmationId, binding: body.binding, accept: true });
  expect(foreign.status).toBe(404);
  expect(settles.n).toBe(0);

  const state = await api(new Request("https://x402-pay.tech-demos.theserverless.dev/api/state", { headers: { cookie: other } }), deps, "/api/state");
  const stateBody = await state.json() as { timeline: { kind: string }[] };
  expect(stateBody.timeline.some((item) => item.kind === "http_402")).toBe(false);

  clock.now += 3 * 60 * 1000;
  const expired = await confirm(deps, cookie, { confirmationId: body.confirmationId, binding: body.binding, accept: true });
  const expiredBody = await expired.json() as { paid: boolean; status: string };
  expect(expired.status).toBe(403);
  expect(expiredBody.paid).toBe(false);
  expect(expiredBody.status).toBe("failed");
  expect(settles.n).toBe(0);

  const hostile = harness({
    probe: async () => view({ isError: true, challenge: challenge(SQUARE_ATOMIC, PAYEE, "eip155:8453") }),
  });
  const hostileCookie = await session(hostile.deps);
  const rejected = await call(hostile.deps, hostileCookie, { tool: "square", args: { number: 2 } });
  const rejectedBody = await rejected.json() as { paid: boolean; error: string };
  expect(rejected.status).toBe(403);
  expect(rejectedBody.paid).toBe(false);
  expect(rejectedBody.error).toBe("wrong_network");
  expect(hostile.settles.n).toBe(0);
});

test("a failed tool and a missing receipt are not marked paid", async () => {
  const failed = harness({
    pay: async () => view({ isError: true, code: "tool_failed", text: "The model call failed. Nothing is marked paid." }),
  });
  const cookie = await session(failed.deps);
  const challenged = await call(failed.deps, cookie, { tool: "summarize", args: { text: "Agents pay per tool call." } });
  const body = await challenged.json() as { confirmationId: string; binding: string };
  const response = await confirm(failed.deps, cookie, { confirmationId: body.confirmationId, binding: body.binding, accept: true });
  const result = await response.json() as { paid: boolean; status: string; error: string };
  expect(result.paid).toBe(false);
  expect(result.status).toBe("failed");
  expect(result.error).toBe("tool_failed");

  const receipt = harness({
    pay: async () => view({ text: "16", success: true, transaction: "mock:aaaaaaaaaaaaaaaa", network: NETWORK }),
  });
  const receiptCookie = await session(receipt.deps);
  const open = await call(receipt.deps, receiptCookie, { tool: "square", args: { number: 4 } });
  const openBody = await open.json() as { confirmationId: string; binding: string };
  const settled = await confirm(receipt.deps, receiptCookie, { confirmationId: openBody.confirmationId, binding: openBody.binding, accept: true });
  const settledBody = await settled.json() as { paid: boolean; status: string };
  expect(settledBody.paid).toBe(false);
  expect(settledBody.status).toBe("failed");
});

test("setup pending and mock settlement are not reported as testnet payments", async () => {
  const pending = harness({ mode: "pending", payee: "" });
  const cookie = await session(pending.deps);
  const response = await call(pending.deps, cookie, { tool: "square", args: { number: 3 } });
  const body = await response.json() as { paid: boolean; error: string; label: string };
  expect(response.status).toBe(503);
  expect(body.paid).toBe(false);
  expect(body.error).toBe("setup_pending");
  expect(body.label.toLowerCase()).toContain("setup pending");
  expect(pending.settles.n).toBe(0);

  const mock = harness({
    mode: "mock",
    payee: "0x0000000000000000000000000000000000000402",
    probe: async (_session, tool) => view({ isError: true, challenge: challenge(tool === "summarize" ? SUMMARY_ATOMIC : SQUARE_ATOMIC, "0x0000000000000000000000000000000000000402") }),
    pay: async () => {
      mock.settles.n += 1;
      return view({ text: "25", success: true, transaction: "mock:abcdefabcdefabcd", network: NETWORK });
    },
  });
  const mockCookie = await session(mock.deps);
  const open = await call(mock.deps, mockCookie, { tool: "square", args: { number: 5 } });
  const openBody = await open.json() as { confirmationId: string; binding: string };
  const settled = await confirm(mock.deps, mockCookie, { confirmationId: openBody.confirmationId, binding: openBody.binding, accept: true });
  const settledBody = await settled.json() as { paid: boolean; settlement: string; label: string };
  expect(settledBody.paid).toBe(false);
  expect(settledBody.settlement).toBe("mock");
  expect(settledBody.label).toContain("Not a Base Sepolia");
});

test("session and global daily caps stop new challenges", async () => {
  const { deps, settles } = harness();
  const cookie = await session(deps);
  for (let i = 0; i < SESSION_PAID_CAP; i++) {
    const response = await call(deps, cookie, { tool: "square", args: { number: i } });
    expect(response.status).toBe(402);
  }
  const blocked = await call(deps, cookie, { tool: "square", args: { number: 1 } });
  expect(blocked.status).toBe(429);
  expect(settles.n).toBe(0);

  const global = harness();
  for (let i = 0; i < GLOBAL_PAID_CAP; i++) {
    const one = await session(global.deps);
    const response = await call(global.deps, one, { tool: "square", args: { number: 1 } });
    expect(response.status).toBe(402);
  }
  const extra = await session(global.deps);
  const over = await call(global.deps, extra, { tool: "square", args: { number: 1 } });
  expect(over.status).toBe(429);
});

test("a paid tool that skips the challenge is not returned as a result", async () => {
  const { deps } = harness({ probe: async () => view({ text: "16", success: true }) });
  const cookie = await session(deps);
  const response = await call(deps, cookie, { tool: "square", args: { number: 4 } });
  const body = await response.json() as { paid: boolean; error: string };
  expect(response.status).toBe(502);
  expect(body.paid).toBe(false);
  expect(body.error).toBe("no_challenge");
});

test("turnstile and rate limits fail closed", async () => {
  const { deps } = harness({ limit: async (bucket) => bucket !== "session" });
  const blocked = await api(new Request("https://x402-pay.tech-demos.theserverless.dev/api/session", {
    method: "POST",
    body: JSON.stringify({ turnstileToken: DUMMY_TOKEN }),
  }), deps, "/api/session");
  expect(blocked.status).toBe(429);

  const open = harness();
  open.deps.verify = (token, ip) =>
    verifyTurnstile({
      secret: "real-secret",
      token,
      ip,
      local: true,
      fetchImpl: async () => new Response(JSON.stringify({ success: false, hostname: "127.0.0.1", action: "x402-pay" })),
    });
  const missing = await api(new Request("https://x402-pay.tech-demos.theserverless.dev/api/session", {
    method: "POST",
    body: JSON.stringify({}),
  }), open.deps, "/api/session");
  expect(missing.status).toBe(400);
  const bad = await api(new Request("https://x402-pay.tech-demos.theserverless.dev/api/session", {
    method: "POST",
    body: JSON.stringify({ turnstileToken: "from-another-demo" }),
  }), open.deps, "/api/session");
  expect(bad.status).toBe(403);
});
