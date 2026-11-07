import {
  CONFIRM_TTL_MS,
  GLOBAL_PAID_CAP,
  MAX_BODY_BYTES,
  MOCK_LABEL,
  NETWORK,
  NETWORK_LABEL,
  PENDING_LABEL,
  SESSION_FREE_CAP,
  SESSION_PAID_CAP,
  SESSION_TTL_MS,
  USDC_BASE_SEPOLIA,
  amountLabel,
  bindingMaterial,
  isPaid,
  parseArgs,
  priceOf,
  randomId,
  randomToken,
  sameString,
  sha256Hex,
  type CanonicalArgs,
  type Mode,
  type ToolName,
} from "../shared/protocol";
import type { ToolView } from "./interpret";
import { interpretPay } from "./interpret";
import {
  appendTimeline,
  chargeDaily,
  claimConfirmation,
  confirmationById,
  dayOf,
  denyConfirmation,
  finishConfirmation,
  insertConfirmation,
  insertSession,
  sessionByHash,
  timelineFor,
  type ConfirmationRow,
} from "./ledger";
import { assessRequirement, boundFor, type Requirement } from "./policy";
import type { Sql } from "./sql";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Deps = {
  sql: Sql;
  now: () => number;
  local: boolean;
  mode: Mode;
  payee: string;
  siteKey: string;
  verify: (token: string, ip: string) => Promise<"ok" | "missing" | "rejected" | "unconfigured">;
  limit: (bucket: "session" | "call" | "confirm" | "read", key: string) => Promise<boolean>;
  probe: (sessionId: string, tool: ToolName, args: CanonicalArgs) => Promise<ToolView>;
  pay: (sessionId: string, tool: ToolName, args: CanonicalArgs) => Promise<ToolView>;
};

const COOKIE = "x402_session";

function clientIp(request: Request): string {
  return (request.headers.get("cf-connecting-ip") ?? "").slice(0, 64);
}

function readCookie(header: string | null): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function cookiePath(base: string): string {
  return base || "/";
}

function setSessionCookie(token: string, base: string, https: boolean): string {
  const secure = https ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=${cookiePath(base)}; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

async function readJson(request: Request): Promise<unknown> {
  const claimed = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(claimed) && claimed > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "The request is too large.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "The request is too large.");
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "bad_json", "The request body is not JSON.");
  }
}

function originOk(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function requirementOf(value: Record<string, unknown>): Requirement {
  return {
    scheme: value.scheme,
    network: value.network,
    asset: value.asset,
    amount: value.amount,
    payTo: value.payTo,
    maxTimeoutSeconds: value.maxTimeoutSeconds,
    extra: value.extra,
  };
}

async function requireSession(deps: Deps, request: Request) {
  const token = readCookie(request.headers.get("cookie"));
  if (!token) throw new HttpError(401, "no_session", "Start a session first.");
  const session = await sessionByHash(deps.sql, await sha256Hex(token), deps.now());
  if (!session) throw new HttpError(401, "no_session", "The session expired. Start again.");
  return session;
}

function challengeBody(tool: ToolName, args: CanonicalArgs, row: ConfirmationRow) {
  return {
    paid: false,
    status: "requested",
    confirmationId: row.id,
    binding: row.binding,
    expiresAt: row.expires_at,
    challenge: {
      tool,
      args,
      scheme: "exact",
      network: NETWORK,
      networkLabel: NETWORK_LABEL,
      asset: USDC_BASE_SEPOLIA,
      assetLabel: "Base Sepolia test USDC",
      amount: row.amount,
      amountLabel: amountLabel(row.amount),
      payTo: row.pay_to,
    },
  };
}

function publicRow(row: ConfirmationRow, mode: Mode) {
  const paid = row.status === "settled" && row.settlement === "testnet";
  const label = row.settlement === "mock" ? MOCK_LABEL : row.status === "settled" ? "Settled on Base Sepolia test USDC." : row.error_code === "setup_pending" ? PENDING_LABEL : "";
  return {
    paid,
    status: row.status,
    settlement: row.settlement,
    label,
    text: row.result_text ?? "",
    transaction: row.transaction_id ?? "",
    error: row.error_code,
    mode,
  };
}

export async function handleApi(request: Request, deps: Deps, path: string, base: string): Promise<Response> {
  if (!originOk(request)) throw new HttpError(403, "origin", "This request came from another site.");
  const ip = clientIp(request);
  if (path === "/api/config" && request.method === "GET") {
    if (!(await deps.limit("read", ip || "unknown"))) throw new HttpError(429, "rate_limited", "Too many reads. Wait a minute.");
    return json({
      siteKey: deps.siteKey,
      action: "x402-pay",
      local: deps.local,
      mode: deps.mode,
      network: NETWORK,
      networkLabel: NETWORK_LABEL,
      prices: { square: "$0.01", summarize: "$0.02" },
      label: deps.mode === "pending" ? PENDING_LABEL : deps.mode === "mock" ? MOCK_LABEL : "Base Sepolia test USDC. Confirm before the agent signs.",
    });
  }

  if (path === "/api/session" && request.method === "POST") {
    if (!(await deps.limit("session", ip || "unknown"))) throw new HttpError(429, "rate_limited", "Too many sessions. Wait a minute.");
    const body = (await readJson(request)) as { turnstileToken?: unknown };
    const token = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
    const verdict = await deps.verify(token, ip);
    if (verdict === "missing") throw new HttpError(400, "turnstile_missing", "Complete the check, then start a session.");
    if (verdict === "unconfigured") throw new HttpError(503, "turnstile_unconfigured", "The check is off until TURNSTILE_SECRET is set.");
    if (verdict !== "ok") throw new HttpError(403, "turnstile_rejected", "The check did not match this demo.");
    const now = deps.now();
    const secret = randomToken();
    const session = { id: randomId(), token_hash: await sha256Hex(secret), created_at: now, expires_at: now + SESSION_TTL_MS };
    await insertSession(deps.sql, session);
    await appendTimeline(deps.sql, session.id, now, "session", { mode: deps.mode });
    return json(
      { paid: false, mode: deps.mode, label: deps.mode === "pending" ? PENDING_LABEL : deps.mode === "mock" ? MOCK_LABEL : "Session ready." },
      200,
      { "set-cookie": setSessionCookie(secret, base, new URL(request.url).protocol === "https:") },
    );
  }

  if (request.method === "GET" && path === "/api/state") {
    if (!(await deps.limit("read", ip || "unknown"))) throw new HttpError(429, "rate_limited", "Too many reads. Wait a minute.");
    const session = await requireSession(deps, request);
    return json({ paid: false, mode: deps.mode, timeline: await timelineFor(deps.sql, session.id) });
  }

  if (request.method === "POST" && path === "/api/call") {
    if (!(await deps.limit("call", ip || "unknown"))) throw new HttpError(429, "rate_limited", "Too many calls. Wait a minute.");
    const session = await requireSession(deps, request);
    const body = (await readJson(request)) as { tool?: unknown; args?: unknown };
    const parsed = parseArgs(typeof body.tool === "string" ? body.tool : "", body.args);
    if ("error" in parsed) throw new HttpError(400, "bad_args", parsed.error);
    if (!isPaid(parsed.tool)) return freeCall(deps, session.id, parsed.args);
    return paidCall(deps, session.id, parsed.tool, parsed.args);
  }

  if (request.method === "POST" && path === "/api/confirm") {
    if (!(await deps.limit("confirm", ip || "unknown"))) throw new HttpError(429, "rate_limited", "Too many confirms. Wait a minute.");
    const session = await requireSession(deps, request);
    const body = (await readJson(request)) as { confirmationId?: unknown; binding?: unknown; accept?: unknown };
    if (typeof body.confirmationId !== "string" || typeof body.binding !== "string" || typeof body.accept !== "boolean") {
      throw new HttpError(400, "bad_confirm", "Send the confirmation id, the binding, and accept true or false.");
    }
    return confirm(deps, session.id, body.confirmationId, body.binding, body.accept);
  }

  throw new HttpError(404, "not_found", "No such API.");
}

async function freeCall(deps: Deps, sessionId: string, args: CanonicalArgs): Promise<Response> {
  const now = deps.now();
  const day = dayOf(now);
  if (!(await chargeDaily(deps.sql, `session:${sessionId}`, day, "free", SESSION_FREE_CAP))) {
    throw new HttpError(429, "daily_cap", "This session has used its free calls for today.");
  }
  const message = typeof args.message === "string" ? args.message : "";
  const view = await deps.probe(sessionId, "echo", { message });
  if (view.isError) throw new HttpError(502, view.code || "tool_failed", view.text || "Echo failed.");
  await appendTimeline(deps.sql, sessionId, now, "tool_result", { tool: "echo", paid: "false" });
  return json({ paid: false, status: "free", text: view.text, timeline: await timelineFor(deps.sql, sessionId), mode: deps.mode });
}

async function paidCall(deps: Deps, sessionId: string, tool: ToolName, args: CanonicalArgs): Promise<Response> {
  const now = deps.now();
  if (deps.mode === "pending") {
    await appendTimeline(deps.sql, sessionId, now, "setup_pending", { tool });
    return json({ paid: false, status: "failed", error: "setup_pending", label: PENDING_LABEL, timeline: await timelineFor(deps.sql, sessionId), mode: deps.mode }, 503);
  }
  const amount = priceOf(tool);
  if (!amount) throw new HttpError(400, "bad_tool", "Unknown tool.");
  const view = await deps.probe(sessionId, tool, args);
  if (view.setup) {
    await appendTimeline(deps.sql, sessionId, now, "setup_pending", { tool });
    return json({ paid: false, status: "failed", error: "setup_pending", label: PENDING_LABEL, timeline: await timelineFor(deps.sql, sessionId), mode: deps.mode }, 503);
  }
  if (!view.challenge) {
    await appendTimeline(deps.sql, sessionId, now, "rejected", { tool, code: "no_challenge" });
    return json(
      { paid: false, status: "failed", error: "no_challenge", label: "The paid tool did not return a payment challenge. Nothing was executed.", timeline: await timelineFor(deps.sql, sessionId), mode: deps.mode },
      502,
    );
  }
  const bound = boundFor(tool, deps.payee, amount);
  const decision = assessRequirement(requirementOf(view.challenge), bound);
  if (!decision.ok) {
    await appendTimeline(deps.sql, sessionId, now, "rejected", { tool, code: decision.code });
    return json({ paid: false, status: "failed", error: decision.code, label: decision.message, timeline: await timelineFor(deps.sql, sessionId), mode: deps.mode }, 403);
  }
  const day = dayOf(now);
  const sessionOk = await chargeDaily(deps.sql, `session:${sessionId}`, day, "paid", SESSION_PAID_CAP);
  const globalOk = sessionOk && (await chargeDaily(deps.sql, "global", day, "paid", GLOBAL_PAID_CAP));
  if (!sessionOk || !globalOk) {
    await appendTimeline(deps.sql, sessionId, now, "cap", { tool });
    throw new HttpError(429, "daily_cap", "The daily paid-call cap is reached. Nothing was charged.");
  }
  const material = bindingMaterial({ tool, args, scheme: "exact", network: NETWORK, asset: USDC_BASE_SEPOLIA, amount, payTo: deps.payee });
  const binding = await sha256Hex(material);
  const row: ConfirmationRow = {
    id: randomId(),
    session_id: sessionId,
    tool,
    args_json: JSON.stringify(args),
    binding,
    network: NETWORK,
    asset: USDC_BASE_SEPOLIA,
    pay_to: deps.payee,
    amount,
    scheme: "exact",
    status: "requested",
    expires_at: now + CONFIRM_TTL_MS,
    created_at: now,
    updated_at: now,
    result_text: null,
    transaction_id: null,
    settlement: null,
    error_code: null,
  };
  await insertConfirmation(deps.sql, row);
  await appendTimeline(deps.sql, sessionId, now, "http_402", { tool, amount, network: NETWORK, payee: deps.payee });
  return json({ ...challengeBody(tool, args, row), timeline: await timelineFor(deps.sql, sessionId), mode: deps.mode }, 402);
}

async function confirm(deps: Deps, sessionId: string, id: string, binding: string, accept: boolean): Promise<Response> {
  const now = deps.now();
  const existing = await confirmationById(deps.sql, id);
  if (!existing || existing.session_id !== sessionId) throw new HttpError(404, "not_found", "That confirmation is not in this session.");
  if (!sameString(existing.binding, binding)) {
    await appendTimeline(deps.sql, sessionId, now, "rejected", { code: "altered" });
    throw new HttpError(403, "altered", "The confirmation does not match the original tool, arguments, amount, network, token, and payee.");
  }
  if (!accept) {
    if (existing.status !== "requested") {
      return json({ ...publicRow(existing, deps.mode), paid: false, timeline: await timelineFor(deps.sql, sessionId) });
    }
    if (existing.expires_at <= now) {
      await finishConfirmation(deps.sql, id, { status: "failed", errorCode: "expired", now });
      await appendTimeline(deps.sql, sessionId, now, "expired", { tool: existing.tool });
      const row = await confirmationById(deps.sql, id);
      return json({ ...(row ? publicRow(row, deps.mode) : { paid: false, status: "failed" }), paid: false, timeline: await timelineFor(deps.sql, sessionId) }, 403);
    }
    await denyConfirmation(deps.sql, id, sessionId, now);
    await appendTimeline(deps.sql, sessionId, now, "denied", { tool: existing.tool });
    const denied = await confirmationById(deps.sql, id);
    return json({ ...(denied ? publicRow(denied, deps.mode) : { paid: false, status: "denied" }), paid: false, timeline: await timelineFor(deps.sql, sessionId) });
  }
  const claim = await claimConfirmation(deps.sql, id, sessionId, now);
  if (claim.kind === "missing") throw new HttpError(404, "not_found", "That confirmation is not in this session.");
  if (claim.kind === "busy") {
    return json({ paid: false, status: "approved", error: "in_progress", label: "That confirm is already running. It has not been marked paid.", timeline: await timelineFor(deps.sql, sessionId), mode: deps.mode }, 409);
  }
  if (claim.kind === "expired") {
    await appendTimeline(deps.sql, sessionId, now, "expired", { tool: existing.tool });
    return json({ ...publicRow(claim.row, deps.mode), paid: false, timeline: await timelineFor(deps.sql, sessionId) }, 403);
  }
  if (claim.kind === "replay") {
    await appendTimeline(deps.sql, sessionId, now, "replay", { tool: existing.tool, status: claim.row.status });
    return json({ ...publicRow(claim.row, deps.mode), timeline: await timelineFor(deps.sql, sessionId), mode: deps.mode });
  }
  await appendTimeline(deps.sql, sessionId, now, "approved", { tool: claim.row.tool, amount: claim.row.amount, network: claim.row.network });
  let args: CanonicalArgs;
  try {
    args = JSON.parse(claim.row.args_json) as CanonicalArgs;
  } catch {
    await finishConfirmation(deps.sql, id, { status: "failed", errorCode: "bad_args", now: deps.now() });
    throw new HttpError(500, "bad_args", "The stored arguments could not be read. Nothing is marked paid.");
  }
  const tool = claim.row.tool === "square" || claim.row.tool === "summarize" ? claim.row.tool : null;
  if (!tool) {
    await finishConfirmation(deps.sql, id, { status: "failed", errorCode: "bad_tool", now: deps.now() });
    throw new HttpError(500, "bad_tool", "The stored tool is not payable. Nothing is marked paid.");
  }
  const view = await deps.pay(sessionId, tool, args);
  const outcome = interpretPay(deps.mode, view);
  if (outcome.kind === "settled") {
    await finishConfirmation(deps.sql, id, {
      status: "settled",
      now: deps.now(),
      text: outcome.text,
      transaction: outcome.transaction,
      settlement: outcome.settlement,
    });
    await appendTimeline(deps.sql, sessionId, deps.now(), outcome.settlement === "mock" ? "mock_settled" : "settled", {
      tool,
      transaction: outcome.transaction,
    });
  } else {
    const code = outcome.kind === "failed" ? outcome.code : "not_settled";
    const message = outcome.kind === "failed" ? outcome.message : outcome.kind === "setup_pending" ? outcome.message : "The payment did not settle.";
    await finishConfirmation(deps.sql, id, { status: "failed", now: deps.now(), errorCode: code, text: message });
    await appendTimeline(deps.sql, sessionId, deps.now(), "failed", { tool, code });
  }
  const row = await confirmationById(deps.sql, id);
  if (!row) throw new HttpError(500, "missing", "The ledger row disappeared. Nothing further was charged.");
  const body = publicRow(row, deps.mode);
  return json({ ...body, paid: body.paid && deps.mode === "testnet", timeline: await timelineFor(deps.sql, sessionId), mode: deps.mode });
}
