import { LIMITS } from "../shared/limits";
import { compareImageBlock, sniffMedia } from "../shared/media";
import { SAMPLES, validateQuestions } from "../shared/questions";
import type { JudgmentView, SampleId, SessionPayload } from "../shared/types";
import { runCompare, VIDEO_COMPARE_REASON } from "./compare";
import {
  countRecentIp,
  countRecentVisitor,
  countSince,
  failJudgment,
  finishJudgment,
  getJudgment,
  getMedia,
  insertJudgment,
  insertMedia,
  listJudgments,
  mediaKey,
  toView,
  type JudgmentRow,
  type MediaRow,
} from "./db";
import { mediaBase64 } from "../shared/clef";
import { runOmni } from "./judge";
import { budgetDecision, hashIpKey, networkKey } from "./policy";
import { parseByteRange } from "../shared/range";
import { environmentName, isLocalRequest, isTestSiteKey, resolveTurnstileSecret, verifyTurnstile } from "./turnstile";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const COOKIE = "__Host-oj_vid";
const VISITOR = /^[a-f0-9]{32}$/;
const ID = /^[a-f0-9]{32}$/;

function json(data: unknown, status = 200, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: { code: err.code, message: err.message } }, err.status);
  console.error(JSON.stringify({ event: "api_error", error: err instanceof Error ? err.name : "error" }));
  return json({ error: { code: "internal", message: "The server failed. Try again." } }, 500);
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

function readVisitor(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) {
      let value = "";
      try {
        value = decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
      return VISITOR.test(value) ? value : null;
    }
  }
  return null;
}

function visitorCookie(visitorId: string): string {
  return `${COOKIE}=${visitorId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
}

function ensureVisitor(request: Request): { id: string; fresh: boolean } {
  const existing = readVisitor(request);
  if (existing) return { id: existing, fresh: false };
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return { id: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""), fresh: true };
}

function withVisitor(request: Request, response: Response, visitor: { id: string; fresh: boolean }): Response {
  if (!visitor.fresh) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", visitorCookie(visitor.id));
  return new Response(response.body, { status: response.status, headers });
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (origin !== new URL(request.url).origin) throw new HttpError(403, "origin", "Origin not allowed.");
}

async function limit(binding: RateLimit, request: Request, message: string): Promise<void> {
  try {
    const { success } = await binding.limit({ key: networkKey(clientIp(request)) });
    if (!success) throw new HttpError(429, "rate_limited", message);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(JSON.stringify({ event: "rate_limit_failed", error: err instanceof Error ? err.name : "error" }));
    throw new HttpError(503, "rate_limit_unavailable", "Rate limiting is unavailable. Try again shortly.");
  }
}

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicSiteKey(env: Env): string | null {
  const key = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (!key || key === "REPLACE_ME") return null;
  return key;
}

function ipSecret(env: Env): string {
  const secret = env.IP_HASH_SECRET?.trim() ?? "";
  if (!secret) throw new HttpError(503, "unconfigured", "IP_HASH_SECRET is not set.");
  return secret;
}

function isSample(value: string): value is SampleId {
  return Object.hasOwn(SAMPLES, value);
}

function requireLength(request: Request, max: number): void {
  const declared = request.headers.get("content-length");
  if (declared === null) throw new HttpError(411, "length_required", "Content-Length is required.");
  const size = Number(declared);
  if (!Number.isInteger(size) || size < 0 || size > max) throw new HttpError(413, "too_large", "The request body is too large.");
}

async function readJson(request: Request): Promise<unknown> {
  requireLength(request, 32_000);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 32_000) throw new HttpError(413, "too_large", "The request body is too large.");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, "bad_json", "The request body must be JSON.");
  }
}

function field(body: unknown, key: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

async function readUpload(request: Request): Promise<{ token: string; questions: unknown; compare: boolean; sampleId: string | null; file: Uint8Array | null; filename: string }> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    requireLength(request, LIMITS.maxBodyBytes);
    const form = await request.formData();
    const token = form.get("turnstileToken");
    const questionsRaw = form.get("questions");
    const sample = form.get("sampleId");
    const compare = form.get("compare");
    const file = form.get("file");
    let questions: unknown = [];
    if (typeof questionsRaw === "string") {
      try {
        questions = JSON.parse(questionsRaw) as unknown;
      } catch {
        throw new HttpError(400, "questions", "Questions must be JSON.");
      }
    }
    let bytes: Uint8Array | null = null;
    let filename = "";
    if (file instanceof File && file.size > 0) {
      if (file.size > LIMITS.maxVideoBytes) throw new HttpError(413, "too_large", "That file is too large.");
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name.slice(0, 80);
    }
    return {
      token: typeof token === "string" ? token : "",
      questions,
      compare: compare === "1" || compare === "true",
      sampleId: typeof sample === "string" && sample ? sample : null,
      file: bytes,
      filename,
    };
  }
  const body = await readJson(request);
  return {
    token: typeof field(body, "turnstileToken") === "string" ? (field(body, "turnstileToken") as string) : "",
    questions: field(body, "questions"),
    compare: field(body, "compare") === true,
    sampleId: typeof field(body, "sampleId") === "string" ? (field(body, "sampleId") as string) : null,
    file: null,
    filename: "",
  };
}

async function loadSample(request: Request, env: Env, sampleId: SampleId): Promise<Uint8Array> {
  const sample = SAMPLES[sampleId];
  const url = new URL(request.url);
  url.pathname = `/samples/${sample.file}`;
  url.search = "";
  const res = await env.ASSETS.fetch(new Request(url, { method: "GET" }));
  if (!res.ok) throw new HttpError(500, "sample", "That sample is missing.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > LIMITS.maxVideoBytes) throw new HttpError(500, "sample", "That sample is too large.");
  return bytes;
}

function ownedMedia(row: MediaRow | null, visitorId: string, now: number): MediaRow {
  if (!row || row.visitor_id !== visitorId || row.expires_at <= now) throw new HttpError(404, "not_found", "That file does not exist.");
  return row;
}

function ownedJudgment(row: JudgmentRow | null, visitorId: string): JudgmentRow {
  if (!row || row.visitor_id !== visitorId) throw new HttpError(404, "not_found", "That judgment does not exist.");
  return row;
}

function fileHeaders(contentType: string, expiresAt: number, now: number): Headers {
  const headers = new Headers();
  headers.set("content-type", contentType);
  const remain = Math.max(0, Math.floor((expiresAt - now) / 1000));
  headers.set("cache-control", remain > 0 ? `private, max-age=${remain}` : "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("x-robots-tag", "noindex");
  headers.set("content-security-policy", "sandbox; default-src 'none'");
  headers.set("accept-ranges", "bytes");
  return headers;
}

function isStoredBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return "body" in object && object.body != null;
}

function etagMatches(httpEtag: string, header: string): boolean {
  const tags = header
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (tags.includes("*")) return true;
  const bare = httpEtag.replace(/^W\//, "").replaceAll('"', "");
  return tags.some((tag) => tag === httpEtag || tag.replace(/^W\//, "").replaceAll('"', "") === bare);
}

function unmodifiedSinceOk(uploaded: Date | undefined, header: string): boolean {
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  if (!uploaded) return true;
  return uploaded.getTime() <= since;
}

async function spend(env: Env, visitorId: string, ipKey: string, now: number): Promise<[number, number, number]> {
  const sinceHour = now - 60 * 60 * 1000;
  const sinceDay = now - LIMITS.retentionMs;
  return Promise.all([countRecentVisitor(env, visitorId, sinceHour), countRecentIp(env, ipKey, sinceHour), countSince(env, sinceDay)]);
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const url = new URL(request.url);
  const visitor = ensureVisitor(request);

  if (request.method === "GET" && path === "/api/health") {
    await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
    let d1 = false;
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      d1 = true;
    } catch (err) {
      console.error(JSON.stringify({ event: "d1_unavailable", error: err instanceof Error ? err.name : "error" }));
    }
    const environment = environmentName(env);
    return withVisitor(request, json({ ok: d1, d1, turnstile: resolveTurnstileSecret(isLocalRequest(request, environment), env.TURNSTILE_SECRET).ok, ai: environment === "local" ? "stub" : "binding" }), visitor);
  }

  if (request.method === "GET" && path === "/api/session") {
    await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
    const secret = ipSecret(env);
    const ipKey = await hashIpKey(clientIp(request), secret);
    const since = Date.now() - 60 * 60 * 1000;
    const [visitorUsed, networkUsed] = await Promise.all([countRecentVisitor(env, visitor.id, since), countRecentIp(env, ipKey, since)]);
    const siteKey = publicSiteKey(env);
    const payload: SessionPayload = {
      siteKey,
      testWidget: isTestSiteKey(siteKey ?? undefined),
      stub: environmentName(env) === "local",
      perVisitorHour: LIMITS.perVisitorHour,
      visitorUsed,
      networkUsed,
      dailyCap: LIMITS.dailyCap,
      retentionHours: 24,
    };
    return withVisitor(request, json(payload), visitor);
  }

  if (request.method === "GET" && path === "/api/judgments") {
    await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
    const rows = await listJudgments(env, visitor.id, Date.now());
    return withVisitor(request, json({ judgments: rows.map(toView) }), visitor);
  }

  const mediaMatch = /^\/api\/media\/([a-f0-9]{32})$/.exec(path);
  if ((request.method === "GET" || request.method === "HEAD") && mediaMatch) {
    await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
    const id = mediaMatch[1] ?? "";
    const now = Date.now();
    const row = ownedMedia(await getMedia(env, id, now), visitor.id, now);
    const head = await env.BUCKET.head(row.r2_key);
    if (!head) throw new HttpError(404, "not_found", "That file does not exist.");
    const headers = fileHeaders(row.content_type, row.expires_at, now);
    if (head.httpEtag) headers.set("etag", head.httpEtag);
    const ifMatch = request.headers.get("if-match");
    const ifUnmodified = request.headers.get("if-unmodified-since");
    if ((ifMatch !== null && !etagMatches(head.httpEtag, ifMatch)) || (ifUnmodified !== null && !unmodifiedSinceOk(head.uploaded, ifUnmodified))) {
      return withVisitor(request, new Response(null, { status: 412, headers }), visitor);
    }
    const ifNone = request.headers.get("if-none-match");
    if (ifNone !== null && etagMatches(head.httpEtag, ifNone)) {
      return withVisitor(request, new Response(null, { status: 304, headers }), visitor);
    }
    const parsed = parseByteRange(request.headers.get("range"), head.size);
    if (parsed.kind === "bad") {
      headers.set("content-range", `bytes */${head.size}`);
      return withVisitor(request, new Response(null, { status: 416, headers }), visitor);
    }
    let status = 200;
    let length = head.size;
    let range: { offset: number; length: number } | { suffix: number } | undefined;
    if (parsed.kind === "span") {
      status = 206;
      length = parsed.length;
      range = { offset: parsed.offset, length: parsed.length };
      headers.set("content-range", `bytes ${parsed.offset}-${parsed.offset + parsed.length - 1}/${head.size}`);
    } else if (parsed.kind === "suffix") {
      status = 206;
      const suffixLength = Math.min(parsed.suffix, head.size);
      const start = head.size - suffixLength;
      length = suffixLength;
      range = { suffix: parsed.suffix };
      headers.set("content-range", `bytes ${start}-${Math.max(start, head.size - 1)}/${head.size}`);
    }
    headers.set("content-length", String(length));
    if (request.method === "HEAD") return withVisitor(request, new Response(null, { status, headers }), visitor);
    const object = await env.BUCKET.get(row.r2_key, range ? { range } : undefined);
    if (!object || !isStoredBody(object)) throw new HttpError(404, "not_found", "That file does not exist.");
    return withVisitor(request, new Response(object.body, { status, headers }), visitor);
  }

  const judgmentMatch = /^\/api\/judgments\/([a-f0-9]{32})$/.exec(path);
  if (request.method === "GET" && judgmentMatch) {
    await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
    const id = judgmentMatch[1] ?? "";
    const row = ownedJudgment(await getJudgment(env, id, Date.now()), visitor.id);
    return withVisitor(request, json(toView(row)), visitor);
  }

  if (request.method === "POST" && path === "/api/judge") {
    assertSameOrigin(request);
    const posted = request.headers.get("content-type") ?? "";
    requireLength(request, posted.includes("multipart/form-data") ? LIMITS.maxBodyBytes : 32_000);
    await limit(env.JUDGE_LIMIT, request, "Too many judgments from this network. Wait a minute.");
    const local = isLocalRequest(request, environmentName(env));
    const secret = resolveTurnstileSecret(local, env.TURNSTILE_SECRET);
    if (!secret.ok) throw new HttpError(503, "turnstile_unconfigured", "Turnstile is not configured. Set TURNSTILE_SECRET.");
    const upload = await readUpload(request);
    if (!upload.token.trim()) throw new HttpError(400, "turnstile_required", "Complete the Turnstile check first.");
    const validated = validateQuestions(upload.questions);
    if (!validated.ok) throw new HttpError(400, "questions", validated.message);
    if (!(await verifyTurnstile(secret.secret, upload.token.trim(), clientIp(request), url.hostname))) {
      throw new HttpError(403, "turnstile_failed", "Turnstile did not pass. Try the check again.");
    }

    let bytes: Uint8Array;
    let sampleId: SampleId | null = null;
    let label = "Upload";
    if (upload.sampleId) {
      if (!isSample(upload.sampleId)) throw new HttpError(400, "sample", "That sample does not exist.");
      sampleId = upload.sampleId;
      bytes = await loadSample(request, env, sampleId);
      label = SAMPLES[sampleId].label;
    } else if (upload.file) {
      bytes = upload.file;
      label = upload.filename || "Upload";
    } else {
      throw new HttpError(400, "media", "Choose a sample or a file.");
    }
    const sniffed = sniffMedia(bytes);
    if (!sniffed.ok) throw new HttpError(400, "media", sniffed.message);

    const compareImageReason = upload.compare && sniffed.kind === "image" ? compareImageBlock(bytes) : null;
    const wantCompare = upload.compare && sniffed.kind !== "video" && !compareImageReason;
    if (wantCompare) await limit(env.COMPARE_LIMIT, request, "Too many comparisons from this network. Wait a minute.");

    const now = Date.now();
    const ipKey = await hashIpKey(clientIp(request), ipSecret(env));
    const [visitorUsed, networkUsed, dailyUsed] = await spend(env, visitor.id, ipKey, now);
    const budget = budgetDecision({ visitor: visitorUsed, network: networkUsed, daily: dailyUsed });
    if (!budget.ok) throw new HttpError(budget.status, budget.code, budget.message);

    const questionsJson = JSON.stringify(validated.questions);
    const omniId = newId();
    const pairId = newId();
    if (!ID.test(omniId) || !ID.test(pairId)) throw new HttpError(500, "internal", "The server failed. Try again.");
    const mediaId = sampleId ? null : newId();
    const inserted = await insertJudgment(env, {
      id: omniId,
      visitorId: visitor.id,
      mediaId,
      sampleId,
      pairId,
      kind: "omni",
      modality: sniffed.kind,
      label,
      ipKey,
      questionsJson,
      now,
    });
    if (!inserted) {
      const [againVisitor, againNetwork, againDaily] = await spend(env, visitor.id, ipKey, now);
      const again = budgetDecision({ visitor: againVisitor, network: againNetwork, daily: againDaily });
      if (!again.ok) throw new HttpError(again.status, again.code, again.message);
      throw new HttpError(429, "hourly", "This network has used its judgments for this hour.");
    }

    if (mediaId) {
      const key = mediaKey(mediaId);
      try {
        await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: sniffed.contentType } });
        await insertMedia(env, {
          id: mediaId,
          visitor_id: visitor.id,
          kind: sniffed.kind,
          content_type: sniffed.contentType,
          bytes: bytes.length,
          duration_ms: sniffed.durationMs,
          r2_key: key,
          now,
        });
      } catch (err) {
        console.error(JSON.stringify({ event: "r2_put_failed", error: err instanceof Error ? err.name : "error" }));
        try {
          await env.BUCKET.delete(key);
        } catch (deleteErr) {
          console.error(JSON.stringify({ event: "r2_delete_failed", error: deleteErr instanceof Error ? deleteErr.name : "error" }));
        }
        await failJudgment(env, omniId, "The file could not be stored.", { clearMedia: true });
        throw new HttpError(503, "storage", "The file could not be stored.");
      }
    }

    const media = { kind: sniffed.kind, contentType: sniffed.contentType, bytes, durationMs: sniffed.durationMs };
    mediaBase64(media);
    const omni = await runOmni(env, media, validated.questions, omniId, sampleId);
    if (!omni.ok) {
      await failJudgment(env, omniId, omni.message);
    } else {
      await finishJudgment(env, omniId, omni.result, omni.result.cost.usd);
    }
    const omniRow = ownedJudgment(await getJudgment(env, omniId, now), visitor.id);

    let comparison: JudgmentView | { available: false; reason: string } | { error: { code: string; message: string } } | null = null;
    if (!omni.ok) {
      comparison = null;
    } else if (sniffed.kind === "video" && upload.compare) {
      comparison = { available: false, reason: VIDEO_COMPARE_REASON };
    } else if (compareImageReason) {
      comparison = { available: false, reason: compareImageReason };
    } else if (wantCompare) {
      const compareNow = Date.now();
      const [cVisitor, cNetwork, cDaily] = await spend(env, visitor.id, ipKey, compareNow);
      const compareBudget = budgetDecision({ visitor: cVisitor, network: cNetwork, daily: cDaily });
      if (!compareBudget.ok) {
        comparison = { error: { code: compareBudget.code, message: compareBudget.message } };
      } else {
        const compareId = newId();
        const compareInserted = await insertJudgment(env, {
          id: compareId,
          visitorId: visitor.id,
          mediaId,
          sampleId,
          pairId,
          kind: "compare",
          modality: sniffed.kind,
          label,
          ipKey,
          questionsJson,
          now: compareNow,
        });
        if (!compareInserted) {
          comparison = { error: { code: "hourly", message: "This network has used its judgments for this hour." } };
        } else {
          const chain = await runCompare(env, media, validated.questions, compareId);
          if (!chain.ok) await failJudgment(env, compareId, chain.message);
          else await finishJudgment(env, compareId, chain.result, chain.result.cost.usd);
          comparison = toView(ownedJudgment(await getJudgment(env, compareId, compareNow), visitor.id));
        }
      }
    }

    const body = { judgment: toView(omniRow), comparison };
    return withVisitor(request, json(body, omni.ok ? 201 : 502), visitor);
  }

  throw new HttpError(404, "not_found", "That API path does not exist.");
}
