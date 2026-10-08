import { AI_UNLOCK_MS, MESSAGE_MAX, NAME_MAX, RACE_MAX, RACE_MIN, ROOM_ALPHABET, ROOM_MESSAGES, ROOM_SOCKETS, SCRATCH_MAX, ACTOR_TTL_MS } from "../shared/types";
import type { LabConfig, RaceMode, RoomResponse } from "../shared/types";
import { isRecord } from "./actor";
import { cleanName, cleanText } from "./chat";
import type { RpcResult } from "./race";
import { HttpError, aiGate, assertTurnstile } from "./turnstile";

const ROOM_RE = new RegExp(`^[${ROOM_ALPHABET}]{6}$`);

function json(data: unknown, status = 200, headers?: Headers): Response {
  const next = headers ?? new Headers();
  next.set("content-type", "application/json; charset=utf-8");
  next.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: next });
}

function clientKey(request: Request): string {
  return (request.headers.get("cf-connecting-ip") ?? "local").slice(0, 64);
}

async function limit(binding: RateLimit, request: Request, label: string): Promise<void> {
  const { success } = await binding.limit({ key: clientKey(request) });
  if (!success) throw new HttpError(429, "rate_limited", `Too many ${label}. Wait a minute.`);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 32_000) throw new HttpError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body must be a JSON object.");
  }
}

function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new HttpError(result.status, result.code, result.message);
  return result.data;
}

function roomCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ROOM_ALPHABET[byte % ROOM_ALPHABET.length]!;
  return out;
}

function config(env: Env, request: Request): LabConfig {
  const ai = aiGate(env, request);
  return {
    ok: true,
    model: env.AI_MODEL,
    ai,
    siteKey: ai === "ready" ? env.TURNSTILE_SITE_KEY : null,
    limits: {
      raceMin: RACE_MIN,
      raceMax: RACE_MAX,
      messageMax: MESSAGE_MAX,
      scratchMax: SCRATCH_MAX,
      roomMessages: ROOM_MESSAGES,
      sockets: ROOM_SOCKETS,
      unlockMs: AI_UNLOCK_MS,
      ttlMs: ACTOR_TTL_MS,
    },
  };
}

export function visitor(request: Request): { id: string; cookie: string | null } {
  const header = request.headers.get("cookie") ?? "";
  const match = header.match(/(?:^|;\s*)actor_lab=([a-f0-9]{32})(?:;|$)/);
  if (match?.[1]) return { id: match[1], cookie: null };
  const id = crypto.randomUUID().replaceAll("-", "");
  const secure = new URL(request.url).protocol === "https:";
  const flags = ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"];
  if (secure) flags.push("Secure");
  return { id, cookie: `actor_lab=${id}; ${flags.join("; ")}` };
}

export function finish(response: Response, cookie: string | null): Response {
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  const init: ResponseInit & { webSocket?: WebSocket } = {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
  if (response.webSocket) init.webSocket = response.webSocket;
  return new Response(response.body, init);
}

export async function handleApi(request: Request, env: Env, pathname: string, visitorId: string): Promise<Response> {
  const method = request.method;
  const race = () => env.RACE.getByName(visitorId);

  if (pathname === "/api/health" && method === "GET") {
    return json({ ok: true, model: env.AI_MODEL, ai: aiGate(env, request) });
  }
  if (pathname === "/api/config" && method === "GET") return json(config(env, request));

  if (pathname === "/api/race/arm" && method === "POST") {
    await limit(env.RACE_LIMIT, request, "race runs");
    const body = await readJson(request);
    await assertTurnstile(env, request, body.token);
    const mode = body.mode === "serialized" || body.mode === "interleaved" ? body.mode : null;
    const n = typeof body.n === "number" ? body.n : Number.NaN;
    if (!mode) throw new HttpError(400, "invalid", "Mode must be serialized or interleaved.");
    if (!Number.isInteger(n) || n < RACE_MIN || n > RACE_MAX) {
      throw new HttpError(400, "invalid", `Fire between ${RACE_MIN} and ${RACE_MAX} updates.`);
    }
    const runId = crypto.randomUUID();
    const armed = unwrap(await race().arm({ runId, mode: mode as RaceMode, expected: n }));
    return json(armed);
  }

  if (pathname === "/api/race/step" && method === "POST") {
    await limit(env.RACE_LIMIT, request, "race runs");
    const body = await readJson(request);
    const runId = typeof body.runId === "string" ? body.runId : "";
    const racer = typeof body.racer === "number" ? body.racer : Number.NaN;
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new HttpError(400, "invalid", "Missing run id.");
    const stepped = unwrap(await race().step({ runId, racer }));
    return json(stepped);
  }

  if (pathname === "/api/race/result" && method === "GET") {
    const runId = new URL(request.url).searchParams.get("runId") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new HttpError(400, "invalid", "Missing run id.");
    return json(unwrap(await race().result(runId)));
  }

  if (pathname === "/api/rooms" && method === "POST") {
    await limit(env.CHAT_LIMIT, request, "chat");
    const code = roomCode();
    const view = unwrap(await env.CHAT.getByName(code).init(Date.now()));
    return json({ ...view, code } satisfies RoomResponse, 201);
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(socket|unlock|scratch|evict|say))?$/);
  if (!roomMatch) throw new HttpError(404, "not_found", "Unknown API route.");
  const code = roomMatch[1] ?? "";
  const action = roomMatch[2] ?? "";
  if (!ROOM_RE.test(code)) throw new HttpError(400, "invalid", "Room codes are 6 characters.");
  const chat = env.CHAT.getByName(code);

  if (action === "socket") {
    await limit(env.CHAT_LIMIT, request, "chat");
    const name = cleanName(new URL(request.url).searchParams.get("name")).slice(0, NAME_MAX);
    const url = new URL(request.url);
    url.searchParams.set("name", name);
    return chat.fetch(new Request(url, request));
  }

  if (action === "" && method === "GET") {
    const view = unwrap(await chat.view());
    return json({ ...view, code } satisfies RoomResponse);
  }

  if (action === "unlock" && method === "POST") {
    await limit(env.CHAT_LIMIT, request, "chat");
    const body = await readJson(request);
    await assertTurnstile(env, request, body.token);
    const view = unwrap(await chat.grantAi(Date.now() + AI_UNLOCK_MS));
    return json({ ...view, code } satisfies RoomResponse);
  }

  if (action === "scratch" && method === "POST") {
    await limit(env.CHAT_LIMIT, request, "chat");
    const body = await readJson(request);
    const text = cleanText(body.text, SCRATCH_MAX + 1);
    if (text.length > SCRATCH_MAX) throw new HttpError(413, "too_large", "Scratch notes must be 280 characters or fewer.");
    const view = unwrap(await chat.setScratch(text));
    return json({ ...view, code } satisfies RoomResponse);
  }

  if (action === "evict" && method === "POST") {
    await limit(env.CHAT_LIMIT, request, "chat");
    const view = unwrap(await chat.evict());
    return json({ ...view, code } satisfies RoomResponse);
  }

  if (action === "say" && method === "POST") {
    await limit(env.CHAT_LIMIT, request, "chat");
    const body = await readJson(request);
    const text = cleanText(body.text, MESSAGE_MAX + 1);
    if (!text) throw new HttpError(400, "invalid", "Write a message first.");
    if (text.length > MESSAGE_MAX) throw new HttpError(413, "too_large", "Messages must be 500 characters or fewer.");
    const said = unwrap(await chat.say({ name: cleanName(body.name), text, ask: body.ask === true }));
    return json({ ...said, code }, 201);
  }

  throw new HttpError(405, "method_not_allowed", "That method is not allowed here.");
}
