import { slugifyRoom, type Health, type RoomInfo } from "../shared/types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

async function limitCreate(env: Env, request: Request): Promise<void> {
  const { success } = await env.CREATE_LIMIT.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many rooms from this address. Wait a minute.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 4_000) throw new HttpError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "bad_json", "The body must be a JSON object.");
  }
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/health" && request.method === "GET") {
    const body: Health = { ok: true, demo: "goodvibes", hibernation: true };
    return json(body);
  }

  if (path === "/api/rooms" && request.method === "POST") {
    await limitCreate(env, request);
    const body = await readJson(request);
    const raw = typeof body.name === "string" ? body.name : typeof body.id === "string" ? body.id : "";
    const id = slugifyRoom(raw);
    const room: RoomInfo = { id, name: id };
    return json({ room }, 201);
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}
