import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BUSY_MS, GLOBAL_PAID_CAP, NETWORK, SESSION_PAID_CAP, SQUARE_ATOMIC, SUMMARY_ATOMIC, USDC_BASE_SEPOLIA, USDC_NAME, USDC_VERSION } from "../shared/protocol";
import { HttpError, handleApi, type Deps } from "./http";
import type { ToolView } from "./interpret";
import { confirmationById, finishOwned, markUnknown } from "./ledger";
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
    reason: "",
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
  const settledBody = await settled.json() as { paid: boolean; status: string; label: string };
  expect(settledBody.paid).toBe(false);
  expect(settledBody.status).toBe("unknown");
  expect(settledBody.label).toContain("Outcome unknown");
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

test("the session quote cap stops new challenges and denied quotes do not use the global cap", async () => {
  const { deps, settles } = harness();
  const cookie = await session(deps);
  for (let i = 0; i < SESSION_PAID_CAP; i++) {
    const response = await call(deps, cookie, { tool: "square", args: { number: i } });
    expect(response.status).toBe(402);
  }
  const blocked = await call(deps, cookie, { tool: "square", args: { number: 1 } });
  expect(blocked.status).toBe(429);
  expect(settles.n).toBe(0);

  const denied = harness();
  for (let i = 0; i < GLOBAL_PAID_CAP; i++) {
    const one = await session(denied.deps);
    const opened = await call(denied.deps, one, { tool: "square", args: { number: 1 } });
    expect(opened.status).toBe(402);
    const quote = (await opened.json()) as { confirmationId: string; binding: string };
    const rejection = await confirm(denied.deps, one, { confirmationId: quote.confirmationId, binding: quote.binding, accept: false });
    expect(rejection.status).toBe(200);
  }
  expect(denied.settles.n).toBe(0);
  const next = await session(denied.deps);
  const opened = await call(denied.deps, next, { tool: "square", args: { number: 4 } });
  expect(opened.status).toBe(402);
  const quote = (await opened.json()) as { confirmationId: string; binding: string };
  const settled = await confirm(denied.deps, next, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  expect(settled.status).toBe(200);
  expect(denied.settles.n).toBe(1);
});

test("accepted payments stop at the global cap before signing", async () => {
  const { deps, settles } = harness();
  for (let i = 0; i < GLOBAL_PAID_CAP; i++) {
    const one = await session(deps);
    const opened = await call(deps, one, { tool: "square", args: { number: 1 } });
    const quote = (await opened.json()) as { confirmationId: string; binding: string };
    const settled = await confirm(deps, one, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
    expect(settled.status).toBe(200);
  }
  expect(settles.n).toBe(GLOBAL_PAID_CAP);
  const extra = await session(deps);
  const opened = await call(deps, extra, { tool: "square", args: { number: 1 } });
  expect(opened.status).toBe(402);
  const quote = (await opened.json()) as { confirmationId: string; binding: string };
  const blocked = await confirm(deps, extra, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  expect(blocked.status).toBe(429);
  expect(settles.n).toBe(GLOBAL_PAID_CAP);
});

test("two accepts settle once", async () => {
  const { deps, settles } = harness();
  let claims = 0;
  let releaseClaims: () => void = () => {};
  const bothClaims = new Promise<void>((resolve, reject) => {
    releaseClaims = resolve;
    setTimeout(() => reject(new Error("both confirms did not reach the compare-and-set")), 1000);
  });
  const run = deps.sql.run.bind(deps.sql);
  deps.sql.run = async (query, params) => {
    if (query.includes("status = 'requested'")) {
      claims += 1;
      if (claims === 2) releaseClaims();
      await bothClaims;
    }
    return run(query, params);
  };
  const cookie = await session(deps);
  const opened = await call(deps, cookie, { tool: "square", args: { number: 4 } });
  const quote = (await opened.json()) as { confirmationId: string; binding: string };
  const [left, right] = await Promise.all([
    confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true }),
    confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true }),
  ]);
  const statuses = [left.status, right.status].sort((a, b) => a - b);
  expect(statuses).toEqual([200, 409]);
  const bodies = (await Promise.all([left.json(), right.json()])) as { paid?: boolean; error?: string; status?: string }[];
  expect(bodies.some((body) => body.status === "settled" && body.paid === true)).toBe(true);
  expect(bodies.some((body) => body.error === "in_progress")).toBe(true);
  expect(claims).toBe(2);
  expect(settles.n).toBe(1);
});

test("confirm passes the stored amount and payee to the signer", async () => {
  const seen: { amount: string; payTo: string }[] = [];
  const { deps } = harness({
    pay: async (_session, _tool, _args, charge) => {
      seen.push(charge);
      return view({ text: "16", success: true, transaction: `0x${"ab".repeat(32)}`, network: NETWORK });
    },
  });
  const cookie = await session(deps);
  const opened = await call(deps, cookie, { tool: "square", args: { number: 4 } });
  const quote = (await opened.json()) as { confirmationId: string; binding: string; challenge: { payTo: string; amount: string } };
  await confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  expect(seen).toEqual([{ amount: quote.challenge.amount, payTo: quote.challenge.payTo }]);
  expect(seen[0]?.amount).toBe(SQUARE_ATOMIC);
  expect(seen[0]?.payTo).toBe(PAYEE);
});

test("a thrown pay is unknown, is not retried, and a late settlement still wins", async () => {
  const { deps, settles, clock } = harness({
    pay: async () => {
      settles.n += 1;
      throw new Error("worker died");
    },
  });
  const cookie = await session(deps);
  const opened = await call(deps, cookie, { tool: "square", args: { number: 4 } });
  const quote = (await opened.json()) as { confirmationId: string; binding: string };
  const crashed = await confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  const crashedBody = (await crashed.json()) as { paid: boolean; status: string; label: string };
  expect(crashed.status).toBe(200);
  expect(crashedBody.paid).toBe(false);
  expect(crashedBody.status).toBe("unknown");
  expect(crashedBody.label).toContain("Outcome unknown");
  expect(crashedBody.label).toContain("Not retried");

  clock.now += BUSY_MS + 1000;
  const retry = await confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  const retryBody = (await retry.json()) as { paid: boolean; status: string };
  expect(retryBody.status).toBe("unknown");
  expect(retryBody.paid).toBe(false);
  expect(settles.n).toBe(1);

  const wrote = await finishOwned(deps.sql, quote.confirmationId, {
    status: "settled",
    now: clock.now,
    text: "16",
    transaction: `0x${"cd".repeat(32)}`,
    settlement: "testnet",
  });
  expect(wrote).toBe(1);
  const row = await confirmationById(deps.sql, quote.confirmationId);
  expect(row?.status).toBe("settled");
  expect(row?.settlement).toBe("testnet");
  const clobber = await markUnknown(deps.sql, quote.confirmationId, "interrupted", clock.now);
  expect(clobber).toBe(0);
  const lateFail = await finishOwned(deps.sql, quote.confirmationId, {
    status: "failed",
    now: clock.now,
    errorCode: "not_settled",
    text: "late failure",
  });
  expect(lateFail).toBe(0);
  const still = await confirmationById(deps.sql, quote.confirmationId);
  expect(still?.status).toBe("settled");
  expect(still?.transaction_id).toBe(`0x${"cd".repeat(32)}`);
});

test("a settlement that arrives after the crash mark is recorded and is not signed twice", async () => {
  let release: (view: ToolView) => void = () => {};
  const { deps, settles, clock } = harness({
    pay: () => {
      settles.n += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const cookie = await session(deps);
  const opened = await call(deps, cookie, { tool: "square", args: { number: 4 } });
  const quote = (await opened.json()) as { confirmationId: string; binding: string };
  const pending = confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  await viWait(() => settles.n === 1);
  clock.now += BUSY_MS + 1000;
  const retry = await confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  const retryBody = (await retry.json()) as { paid: boolean; status: string; label: string };
  expect(retryBody.status).toBe("unknown");
  expect(retryBody.paid).toBe(false);
  expect(retryBody.label).toContain("Outcome unknown");
  expect(settles.n).toBe(1);
  release(view({ text: "16", success: true, transaction: `0x${"ab".repeat(32)}`, network: NETWORK }));
  const first = await pending;
  const firstBody = (await first.json()) as { paid: boolean; status: string };
  expect(first.status).toBe(200);
  expect(firstBody.status).toBe("settled");
  expect(firstBody.paid).toBe(true);
  expect(settles.n).toBe(1);
});

test("a settle error stays unknown and a late failure does not replace it", async () => {
  const raw = JSON.stringify({ error: "SETTLEMENT_FAILED", accepts: [{ amount: SQUARE_ATOMIC }], x402Version: 2 });
  for (const reason of ["INVALID_PAYMENT", "PAYMENT_REQUIRED", "", "not-a-known-reason"]) {
    const direct = harness({
      pay: async () => view({
        isError: true,
        challenge: challenge(SQUARE_ATOMIC),
        reason,
        text: JSON.stringify({ error: reason, accepts: [{ amount: SQUARE_ATOMIC }], x402Version: 2 }),
      }),
    });
    const cookie = await session(direct.deps);
    const opened = await call(direct.deps, cookie, { tool: "square", args: { number: 4 } });
    const quote = (await opened.json()) as { confirmationId: string; binding: string };
    const response = await confirm(direct.deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
    const body = (await response.json()) as { paid: boolean; status: string; label: string; text: string };
    expect(body.status).toBe("unknown");
    expect(body.paid).toBe(false);
    expect(body.label).toContain("Outcome unknown");
    expect(body.text).not.toContain("accepts");
    const row = await confirmationById(direct.deps.sql, quote.confirmationId);
    expect(row?.status).toBe("unknown");
    expect(row?.error_code).toBe("settle_unknown");
  }

  const rejected = harness({
    pay: async () => view({
      isError: true,
      challenge: challenge(SQUARE_ATOMIC),
      reason: "facilitator_rejected",
      text: "{\"error\":\"facilitator_rejected\",\"accepts\":[]}",
    }),
  });
  const rejectedCookie = await session(rejected.deps);
  const rejectedOpen = await call(rejected.deps, rejectedCookie, { tool: "square", args: { number: 4 } });
  const rejectedQuote = (await rejectedOpen.json()) as { confirmationId: string; binding: string };
  const rejectedResponse = await confirm(rejected.deps, rejectedCookie, {
    confirmationId: rejectedQuote.confirmationId,
    binding: rejectedQuote.binding,
    accept: true,
  });
  const rejectedBody = (await rejectedResponse.json()) as { paid: boolean; status: string; text: string };
  expect(rejectedBody.status).toBe("unknown");
  expect(rejectedBody.paid).toBe(false);
  expect(rejectedBody.text).not.toContain("accepts");

  const badNetwork = harness({
    pay: async () => view({ text: "16", success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453" }),
  });
  const badCookie = await session(badNetwork.deps);
  const badOpen = await call(badNetwork.deps, badCookie, { tool: "square", args: { number: 4 } });
  const badQuote = (await badOpen.json()) as { confirmationId: string; binding: string };
  const badResponse = await confirm(badNetwork.deps, badCookie, {
    confirmationId: badQuote.confirmationId,
    binding: badQuote.binding,
    accept: true,
  });
  const badBody = (await badResponse.json()) as { paid: boolean; status: string };
  expect(badBody.status).toBe("unknown");
  expect(badBody.paid).toBe(false);

  let release: (view: ToolView) => void = () => {};
  const { deps, settles, clock } = harness({
    pay: () => {
      settles.n += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const deferredCookie = await session(deps);
  const deferredOpen = await call(deps, deferredCookie, { tool: "square", args: { number: 4 } });
  const deferredQuote = (await deferredOpen.json()) as { confirmationId: string; binding: string };
  const pending = confirm(deps, deferredCookie, {
    confirmationId: deferredQuote.confirmationId,
    binding: deferredQuote.binding,
    accept: true,
  });
  await viWait(() => settles.n === 1);
  clock.now += BUSY_MS + 1000;
  const retry = await confirm(deps, deferredCookie, {
    confirmationId: deferredQuote.confirmationId,
    binding: deferredQuote.binding,
    accept: true,
  });
  const retryBody = (await retry.json()) as { status: string; paid: boolean };
  expect(retryBody.status).toBe("unknown");
  expect(retryBody.paid).toBe(false);
  release(view({ isError: true, challenge: challenge(SQUARE_ATOMIC), reason: "SETTLEMENT_FAILED", text: raw }));
  const first = await pending;
  const firstBody = (await first.json()) as { status: string; paid: boolean; text: string };
  expect(first.status).toBe(200);
  expect(firstBody.status).toBe("unknown");
  expect(firstBody.paid).toBe(false);
  expect(firstBody.text).not.toContain("accepts");
  const row = await confirmationById(deps.sql, deferredQuote.confirmationId);
  expect(row?.status).toBe("unknown");
  expect(row?.error_code).toBe("interrupted");
  expect(settles.n).toBe(1);
});

test("a late receipt through confirm resolves settle_unknown and does not sign again", async () => {
  let release: (view: ToolView) => void = () => {};
  const { deps, settles, clock } = harness({
    pay: () => {
      settles.n += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const cookie = await session(deps);
  const opened = await call(deps, cookie, { tool: "square", args: { number: 4 } });
  const quote = (await opened.json()) as { confirmationId: string; binding: string };
  const pending = confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  await viWait(() => settles.n === 1);
  const marked = await markUnknown(deps.sql, quote.confirmationId, "settle_unknown", clock.now);
  expect(marked).toBe(1);
  expect((await confirmationById(deps.sql, quote.confirmationId))?.error_code).toBe("settle_unknown");
  release(view({ text: "16", success: true, transaction: `0x${"ef".repeat(32)}`, network: NETWORK }));
  const first = await pending;
  const firstBody = (await first.json()) as { paid: boolean; status: string };
  expect(first.status).toBe(200);
  expect(firstBody.status).toBe("settled");
  expect(firstBody.paid).toBe(true);
  expect(settles.n).toBe(1);
  clock.now += BUSY_MS + 1000;
  const retry = await confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  const retryBody = (await retry.json()) as { paid: boolean; status: string };
  expect(retryBody.status).toBe("settled");
  expect(retryBody.paid).toBe(true);
  expect(settles.n).toBe(1);
});

test("an agent error after an owned confirm is unknown and is not retried", async () => {
  const { deps, settles, clock } = harness({
    pay: async () => {
      settles.n += 1;
      return view({ isError: true, code: "agent_error", text: "The agent could not complete that call." });
    },
  });
  const cookie = await session(deps);
  const opened = await call(deps, cookie, { tool: "square", args: { number: 4 } });
  const quote = (await opened.json()) as { confirmationId: string; binding: string };
  const crashed = await confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  const body = (await crashed.json()) as { paid: boolean; status: string };
  expect(body.status).toBe("unknown");
  expect(body.paid).toBe(false);
  clock.now += BUSY_MS + 1000;
  await confirm(deps, cookie, { confirmationId: quote.confirmationId, binding: quote.binding, accept: true });
  expect(settles.n).toBe(1);
});

async function viWait(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("the pay call did not start");
}

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
