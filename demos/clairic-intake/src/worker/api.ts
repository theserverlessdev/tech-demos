import { LIMITS } from "../shared/limits";
import { budgetDecision, guardFailure, type LimitName } from "../shared/budget";
import { PRESETS } from "../shared/presets";
import { SAMPLES } from "../shared/samples";
import { parseCorrections, validateFields, validateImage, validateState } from "../shared/schema";
import type { Answer } from "../shared/types";
import { enqueueBundledInbox, newId, publicInbox } from "./batch";
import { insertUpload, listInbox, reserveCalls, reviewInbox, spendUsed, type ReserveResult } from "./db";
import { clientIp, hashIp } from "./ip";
import { runClairic, runCompare, runDecide, useMock } from "./models";
import { isLocalRequest, isTestSiteKey, resolveTurnstileSecret, verifyTurnstile, type TurnstileAction } from "./turnstile";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const LIMIT_BINDING: Record<LimitName, keyof Pick<Env, "EXTRACT_LIMIT" | "COMPARE_LIMIT" | "DECIDE_LIMIT" | "BATCH_LIMIT" | "UPLOAD_LIMIT" | "READ_LIMIT" | "REVIEW_LIMIT">> = {
  extract: "EXTRACT_LIMIT",
  compare: "COMPARE_LIMIT",
  decide: "DECIDE_LIMIT",
  batch: "BATCH_LIMIT",
  upload: "UPLOAD_LIMIT",
  read: "READ_LIMIT",
  review: "REVIEW_LIMIT",
};

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: { code: err.code, message: err.message } }, err.status);
  console.error(JSON.stringify({ event: "intake_error", error: err instanceof Error ? err.message : "error" }));
  return json({ error: { code: "internal", message: "Something went wrong." } }, 500);
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/health") return health(env);
  if (request.method === "GET" && path === "/api/config") return config(request, env);
  if (request.method === "GET" && path === "/api/review") return reviewList(request, env);
  if (request.method === "POST" && path === "/api/extract") return extract(request, env);
  if (request.method === "POST" && path === "/api/decide") return decide(request, env);
  if (request.method === "POST" && path === "/api/batch") return batch(request, env);
  const reviewMatch = path.match(/^\/api\/review\/([a-f0-9]{32})$/);
  if (request.method === "POST" && reviewMatch) return reviewOne(request, env, reviewMatch[1]);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: { code: "method", message: "Method not allowed." } }, 405);
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
}

function health(env: Env): Response {
  return json({
    ok: true,
    ai: useMock(env) ? "mock" : "binding",
    model: env.CLAIRIC_MODEL,
    compareModel: env.COMPARE_MODEL,
    clefModel: env.CLEF_MODEL,
  }, 200);
}

async function config(request: Request, env: Env): Promise<Response> {
  const visitor = await enforceLimit(request, env, "read");
  const local = isLocalRequest(request, env.ENVIRONMENT);
  return json({
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    testSiteKey: isTestSiteKey(env.TURNSTILE_SITE_KEY),
    placeholderSiteKey: env.TURNSTILE_SITE_KEY.trim() === "TURNSTILE_SITE_KEY",
    mock: useMock(env),
    models: { clairic: env.CLAIRIC_MODEL, compare: env.COMPARE_MODEL, clef: env.CLEF_MODEL },
    dailyCalls: LIMITS.dailyCalls,
    maxStateChars: LIMITS.maxStateChars,
    maxImageBytes: LIMITS.maxImageBytes,
    presets: PRESETS,
    samples: SAMPLES.map((sample) => ({ id: sample.id, title: sample.title, preset: sample.preset, image: sample.image ?? null })),
    inboxCount: 12,
    local,
  }, 200, visitor, request);
}

async function extract(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const { visitor, ipKey, body } = await begin(request, env, "extract", "extract");
  const record = objectBody(body);
  const imageInput = record.image;
  const image = imageInput ? validateImage(imageInput) : null;
  if (image && !image.ok) throw new HttpError(400, "bad_image", image.message);
  if (image?.ok) await enforceLimit(request, env, "upload", ipKey);
  const state = validateState(record.state, !!image?.ok);
  if (!state.ok) throw new HttpError(400, "bad_schema", state.message);
  const fields = validateFields(record.fields);
  if (!fields.ok) throw new HttpError(400, "bad_schema", fields.message);
  const compare = record.compare === true && state.state.trim().length > 0;
  if (compare) await enforceLimit(request, env, "compare", ipKey);
  const guard = guardFailure({
    bodyBytes: 0,
    stateChars: state.state.length,
    images: image?.ok ? 1 : 0,
    imageBytes: image?.ok ? image.image.bytes.byteLength : 0,
    remoteImage: false,
    turnstileOk: true,
    rateOk: true,
    budgetOk: true,
  });
  if (guard) throw new HttpError(400, guard.code, guard.message);
  const calls = compare ? 2 : 1;
  await reserveOrThrow(env, ipKey, now, calls);
  let uploadId: string | null = null;
  if (image?.ok) {
    uploadId = newId();
    const key = `intake/${visitor.id}/${uploadId}`;
    await env.BUCKET.put(key, image.image.bytes, {
      httpMetadata: { contentType: image.image.content_type },
      customMetadata: { created: String(now) },
    });
    await insertUpload(env, { id: uploadId, visitorId: visitor.id, key, contentType: image.image.content_type, bytes: image.image.bytes.byteLength, now });
  }
  try {
    const extraction = await runClairic(env, state.state, fields.fields, image?.ok ? image.image : null, now);
    const comparison = compare ? await runCompare(env, state.state, fields.fields) : undefined;
    return json({ ...extraction, comparison, id: newId(), uploadId, labelled: extraction.source === "mock" }, 200, visitor, request);
  } catch (err) {
    console.warn(JSON.stringify({ event: "extract_failed", error: err instanceof Error ? err.message : "error" }));
    throw new HttpError(502, "ai_failed", "The model did not return a usable extraction.");
  }
}

async function decide(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const { visitor, ipKey, body } = await begin(request, env, "decide", "decide");
  const record = objectBody(body);
  const fields = validateFields(record.fields);
  if (!fields.ok) throw new HttpError(400, "bad_schema", fields.message);
  const answers = readAnswers(record.answers, fields.fields);
  await reserveOrThrow(env, ipKey, now, 1);
  try {
    const decision = await runDecide(env, answers);
    return json({ ...decision, labelled: decision.source === "mock" }, 200, visitor, request);
  } catch (err) {
    console.warn(JSON.stringify({ event: "decide_failed", error: err instanceof Error ? err.message : "error" }));
    throw new HttpError(502, "ai_failed", "Clef did not return a decision.");
  }
}

async function batch(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const { visitor, ipKey } = await begin(request, env, "batch", "batch");
  const count = 12;
  await reserveOrThrow(env, ipKey, now, count);
  try {
    const ids = await enqueueBundledInbox(env, visitor.id, ipKey, now);
    return json({ ids, labelled: useMock(env) }, 202, visitor, request);
  } catch (err) {
    console.warn(JSON.stringify({ event: "batch_failed", error: err instanceof Error ? err.message : "error" }));
    throw new HttpError(502, "queue_failed", "The inbox could not be queued.");
  }
}

async function reviewList(request: Request, env: Env): Promise<Response> {
  const visitor = await enforceLimit(request, env, "read");
  const rows = await listInbox(env, visitor.id);
  return json({ items: rows.map(publicInbox) }, 200, visitor, request);
}

async function reviewOne(request: Request, env: Env, id: string): Promise<Response> {
  const visitor = await enforceLimit(request, env, "review");
  const body = objectBody(await readJson(request));
  const action = body.action;
  if (action !== "accept" && action !== "correct") throw new HttpError(400, "bad_schema", "Action must be accept or correct.");
  let corrections: string | null = null;
  if (action === "correct") {
    const row = (await listInbox(env, visitor.id)).find((item) => item.id === id);
    if (!row) throw new HttpError(404, "not_found", "That inbox item is not on this desk.");
    const fields = validateFields(JSON.parse(row.fields_json));
    if (!fields.ok) throw new HttpError(400, "bad_schema", fields.message);
    const parsed = parseCorrections(fields.fields, body.corrections);
    if (!parsed.ok) throw new HttpError(400, "bad_schema", parsed.message);
    corrections = JSON.stringify(parsed.corrections);
  }
  const saved = await reviewInbox(env, id, visitor.id, corrections, Date.now());
  if (!saved) throw new HttpError(404, "not_found", "That item is not waiting for review.");
  const rows = await listInbox(env, visitor.id);
  const item = rows.find((row) => row.id === id);
  return json({ item: item ? publicInbox(item) : null }, 200, visitor, request);
}

async function reserveOrThrow(env: Env, ipKey: string, now: number, calls: number): Promise<void> {
  const reserved: ReserveResult = await reserveCalls(env.DB, ipKey, now, calls);
  if (reserved === "ok") return;
  if (reserved === "global") {
    throw new HttpError(503, "daily", "The shared Workers AI budget for today is used up. Try again tomorrow.");
  }
  const used = await spendUsed(env.DB, ipKey, now);
  const decision = budgetDecision(used, calls);
  throw new HttpError(429, "budget", decision.ok ? "This network is out of paid calls for today." : decision.message);
}

async function begin(request: Request, env: Env, limit: LimitName, action: TurnstileAction) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > LIMITS.maxBodyBytes) throw new HttpError(413, "too_large", "That request is too large.");
  const visitor = await enforceLimit(request, env, limit);
  const body = await readJson(request);
  const token = body && typeof body === "object" && typeof (body as { turnstileToken?: unknown }).turnstileToken === "string"
    ? (body as { turnstileToken: string }).turnstileToken
    : "";
  if (!token) throw new HttpError(400, "turnstile_required", "Complete the Turnstile check first.");
  const local = isLocalRequest(request, env.ENVIRONMENT);
  const secret = resolveTurnstileSecret(local, env.TURNSTILE_SECRET);
  if (!secret.ok) throw new HttpError(503, "turnstile_unconfigured", "Turnstile is not configured.");
  const ok = await verifyTurnstile(secret.secret, token, clientIp(request), new URL(request.url).hostname, action);
  if (!ok) throw new HttpError(403, "turnstile_failed", "The Turnstile check did not pass.");
  const ipKey = await hashIp(clientIp(request), ipSecret(env));
  return { visitor, ipKey, body };
}

async function enforceLimit(request: Request, env: Env, name: LimitName, ipKey?: string): Promise<{ id: string; fresh: boolean }> {
  const visitor = readVisitor(request);
  const key = ipKey ?? (await hashIp(clientIp(request), ipSecret(env)));
  const binding = env[LIMIT_BINDING[name]];
  const result = await binding.limit({ key });
  if (!result.success) throw new HttpError(429, "rate_limited", "Too many requests from this network. Wait a minute and try again.");
  return visitor;
}

function ipSecret(env: Env): string {
  const secret = env.IP_HASH_SECRET?.trim() ?? "";
  if (!secret) throw new HttpError(500, "config", "IP_HASH_SECRET is not set.");
  return secret;
}

function readVisitor(request: Request): { id: string; fresh: boolean } {
  const existing = readCookie(request.headers.get("cookie"), "ci_vid");
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return { id: existing, fresh: false };
  return { id: newId(), fresh: true };
}

async function readJson(request: Request): Promise<unknown> {
  const text = await readBounded(request);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "Send JSON.");
  }
}

async function readBounded(request: Request): Promise<string> {
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > LIMITS.maxBodyBytes) {
      await reader.cancel();
      throw new HttpError(413, "too_large", "That request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "bad_json", "Send a JSON object.");
  return body as Record<string, unknown>;
}

export function readAnswers(input: unknown, fields: Record<string, unknown>): Record<string, Answer> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "bad_schema", "Missing extracted answers.");
  const answers: Record<string, Answer> = {};
  for (const name of Object.keys(fields)) {
    const raw = (input as Record<string, unknown>)[name];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      answers[name] = { type: "text", value: null };
      continue;
    }
    const record = raw as Record<string, unknown>;
    const answer: Answer = { type: typeof record.type === "string" ? record.type : "text", value: null };
    if (Array.isArray(record.value) || typeof record.value === "number" || typeof record.value === "string" || record.value === null) {
      answer.value = record.value;
    }
    const confidence = finiteNumber(record.confidence);
    if (confidence !== undefined) answer.confidence = confidence;
    const pNull = finiteNumber(record.p_null);
    if (pNull !== undefined) answer.p_null = pNull;
    const median = finiteNumber(record.median);
    if (median !== undefined) answer.median = median;
    else {
      const series = finiteList(record.median);
      if (series) answer.median = series;
    }
    answers[name] = answer;
  }
  return answers;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteList(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) return undefined;
  return value;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function json(body: unknown, status: number, visitor?: { id: string; fresh: boolean }, request?: Request): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  if (visitor?.fresh && request) {
    const secure = new URL(request.url).protocol === "https:";
    headers.append("set-cookie", `ci_vid=${visitor.id}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
  }
  return new Response(JSON.stringify(body), { status, headers });
}
