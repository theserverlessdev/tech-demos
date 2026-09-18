import { HOST } from "../shared/schedule";
import type { BookRequest } from "../shared/types";
import { calendarStub } from "./calendar";
import { countBookings, countReminders, getBooking } from "./db";

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
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

async function limitBook(env: Env, request: Request): Promise<void> {
  const { success } = await env.BOOK_LIMIT.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many booking attempts from this address. Wait a minute.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 8_000) throw new HttpError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body must be JSON.");
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseBook(body: Record<string, unknown>): BookRequest {
  const guestName = str(body.guestName).trim();
  const guestEmail = str(body.guestEmail).trim().toLowerCase();
  const slotStart = str(body.slotStart).trim();
  if (guestName.length < 2 || guestName.length > 80) throw new HttpError(400, "invalid", "Enter a name (2–80 characters).");
  if (!EMAIL_RE.test(guestEmail) || guestEmail.length > 120) throw new HttpError(400, "invalid", "Enter a valid email.");
  if (!slotStart) throw new HttpError(400, "invalid", "Pick a slot first.");
  return { guestName, guestEmail, slotStart };
}

export async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const method = request.method;
  const calendar = calendarStub(env);

  if (pathname === "/api/health" && method === "GET") {
    return json({
      ok: true,
      hostId: env.HOST_ID || HOST.id,
      bookings: await countBookings(env.DB),
      reminders: await countReminders(env.DB),
    });
  }

  if (pathname === "/api/host" && method === "GET") {
    return json({ host: HOST });
  }

  if (pathname === "/api/availability" && method === "GET") {
    return json(await calendar.availability());
  }

  if (pathname === "/api/book" && method === "POST") {
    await limitBook(env, request);
    const result = await calendar.book(parseBook(await readJson(request)));
    if (!result.ok) {
      const status = result.code === "slot_taken" ? 409 : 400;
      return json({ error: { code: result.code, message: result.message } }, status);
    }
    return json({ booking: result.booking }, 201);
  }

  const bookingMatch = pathname.match(/^\/api\/bookings\/([^/]+)$/);
  if (bookingMatch && method === "GET") {
    const booking = await getBooking(env.DB, decodeURIComponent(bookingMatch[1]!));
    if (!booking) throw new HttpError(404, "not_found", "That booking is gone.");
    return json({ booking });
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}
