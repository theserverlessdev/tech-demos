import { JOIN_TICKET_TTL_MS, MAX_PLAYERS, slugifyRoom, type Health, type JoinTicket, type PublicConfig } from "../shared/types";
import { mintJoinTicket } from "./ticket";
import { assessTurnstile, verifyTurnstile } from "./turnstile";

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

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export function testCredentialsAllowed(env: Env): boolean {
  return (env.TURNSTILE_LOCAL as string) === "1";
}

export function turnstileOpen(env: Env): boolean {
  return (
    assessTurnstile({
      secret: env.TURNSTILE_SECRET ?? "",
      siteKey: env.TURNSTILE_SITE_KEY ?? "",
      allowTestCredentials: testCredentialsAllowed(env),
    }) === "open"
  );
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "bad_length", "The Content-Length header is invalid.");
    if (n > 4_000) throw new HttpError(413, "too_large", "The request body is too large.");
  }
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
    const body: Health = { ok: true, demo: "goodvibes", game: "ember-rush", hibernation: true };
    return json(body);
  }

  if (path === "/api/config" && request.method === "GET") {
    const secret = env.TURNSTILE_SECRET ?? "";
    const siteKey = (env.TURNSTILE_SITE_KEY ?? "").trim();
    const createOpen = turnstileOpen(env);
    const body: PublicConfig = {
      siteKey: createOpen ? siteKey : null,
      createOpen,
      maxPlayers: MAX_PLAYERS,
    };
    return json(body);
  }

  if (path === "/api/rooms" && request.method === "POST") {
    const secret = env.TURNSTILE_SECRET ?? "";
    const siteKey = env.TURNSTILE_SITE_KEY ?? "";
    if (!turnstileOpen(env)) {
      throw new HttpError(503, "closed", "Joining is off until Turnstile is configured for this host.");
    }
    const joinSecret = (env.JOIN_SECRET ?? "").trim();
    if (!joinSecret) throw new HttpError(503, "closed", "Joining is off until JOIN_SECRET is set.");
    const body = await readJson(request);
    const token = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
    if (!/^[A-Za-z0-9._-]{20,2048}$/.test(token)) throw new HttpError(400, "invalid", "Missing Turnstile token.");
    const host = new URL(request.url).hostname;
    const ok = await verifyTurnstile(secret, token, clientIp(request), host);
    if (!ok) throw new HttpError(403, "turnstile", "Turnstile could not verify this browser.");
    const raw = typeof body.name === "string" ? body.name : typeof body.id === "string" ? body.id : "";
    const id = slugifyRoom(raw);
    const minted = await mintJoinTicket(joinSecret, id);
    const ticket: JoinTicket = { room: { id, name: id }, ticket: minted.ticket, expiresAt: minted.expiresAt };
    return json(ticket, 201);
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}

export { JOIN_TICKET_TTL_MS };
