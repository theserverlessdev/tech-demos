import type { BookRequest, BookResponse, Booking, Health, HostPublic, MailResult, MailStatus, ReminderMessage } from "../shared/types";
import { calendarStub } from "./calendar";
import {
  delaySecondsUntil,
  googleEnabled,
  hostFromEnv,
  mailFrom,
  publicBase,
  reminderSendAt,
  resendEnabled,
  turnstileEnabled,
} from "./config";
import { countBookings, countReminders, getBooking, isGoogleConnected, listUpcoming, setGoogleEvent, setMailStatus } from "./db";
import {
  adminRedirect,
  createGoogleEvent,
  deleteGoogleEvent,
  disconnectGoogle,
  googleStatus,
  handleGoogleCallback,
  parseMockBusy,
  startGoogleOAuth,
} from "./google";
import { bookingIcs } from "./ics";
import { sendCancelled, sendConfirmation } from "./mail";
import { bearerToken, secretEquals, signingSecret, signToken, verifyToken } from "./sign";
import { verifyTurnstile } from "./turnstile";

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
  const turnstileToken = str(body.turnstileToken).trim() || undefined;
  if (guestName.length < 2 || guestName.length > 80) throw new HttpError(400, "invalid", "Enter a name (2–80 characters).");
  if (!EMAIL_RE.test(guestEmail) || guestEmail.length > 120) throw new HttpError(400, "invalid", "Enter a valid email.");
  if (!slotStart) throw new HttpError(400, "invalid", "Pick a slot first.");
  return { guestName, guestEmail, slotStart, turnstileToken };
}

async function bookingLinks(env: Env, request: Request, bookingId: string): Promise<{ ics: string; cancel: string }> {
  const base = publicBase(env, request);
  const { secret } = signingSecret(env);
  const ics = await signToken(secret, "ics", bookingId);
  const cancel = await signToken(secret, "cancel", bookingId);
  return {
    ics: `${base}/api/bookings/${bookingId}/ics?t=${encodeURIComponent(ics)}`,
    cancel: `${base}/cancel?id=${encodeURIComponent(bookingId)}&t=${encodeURIComponent(cancel)}`,
  };
}

async function requireAdmin(env: Env, request: Request): Promise<void> {
  const expected = env.ADMIN_API_KEY?.trim();
  if (!expected) throw new HttpError(503, "admin_disabled", "Set ADMIN_API_KEY to enable the host list.");
  const token = bearerToken(request);
  if (!token || !(await secretEquals(token, expected))) {
    throw new HttpError(401, "unauthorized", "Admin key required.");
  }
}

async function tokenFromRequest(request: Request): Promise<string> {
  const fromQuery = new URL(request.url).searchParams.get("t") ?? "";
  if (fromQuery) return fromQuery;
  if (request.method === "GET" || request.method === "HEAD") return "";
  return str((await readJson(request)).t);
}

async function requireSigned(env: Env, purpose: "ics" | "cancel", bookingId: string, request: Request): Promise<void> {
  const token = await tokenFromRequest(request);
  const { secret } = signingSecret(env);
  if (!(await verifyToken(secret, purpose, bookingId, token))) {
    throw new HttpError(403, "forbidden", "That link is invalid or expired.");
  }
}

async function enqueueReminder(env: Env, booking: Booking): Promise<void> {
  const sendAt = reminderSendAt(booking.slotStart);
  const body: ReminderMessage = { bookingId: booking.id, sendAt, kind: "reminder" };
  await env.REMINDERS.send(body, { delaySeconds: delaySecondsUntil(sendAt) });
}

export async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const method = request.method;
  const calendar = calendarStub(env);
  const host = hostFromEnv(env);

  if (pathname === "/api/health" && method === "GET") {
    const health: Health = {
      ok: true,
      hostId: host.id,
      bookings: await countBookings(env.DB),
      reminders: await countReminders(env.DB),
      mail: { resend: resendEnabled(env), from: mailFrom(env) },
      turnstile: turnstileEnabled(env),
      admin: Boolean(env.ADMIN_API_KEY?.trim()),
      signing: signingSecret(env).mode,
      google: { configured: googleEnabled(env), connected: await isGoogleConnected(env.DB, host.id) },
    };
    return json(health);
  }

  if (pathname === "/api/host" && method === "GET") {
    const payload: HostPublic = {
      host,
      turnstileSiteKey: env.TURNSTILE_SITE_KEY?.trim() || null,
      mailEnabled: resendEnabled(env),
      google: (await isGoogleConnected(env.DB, host.id)) || parseMockBusy(env).length > 0 ? "merged" : "off",
    };
    return json(payload);
  }

  if (pathname === "/api/availability" && method === "GET") {
    return json(await calendar.availability());
  }

  if (pathname === "/api/book" && method === "POST") {
    await limitBook(env, request);
    const body = parseBook(await readJson(request));
    if (env.TURNSTILE_SECRET_KEY?.trim()) {
      const ok = await verifyTurnstile(env, body.turnstileToken ?? "", clientIp(request));
      if (!ok) throw new HttpError(403, "turnstile", "Turnstile verification failed. Reload and try again.");
    }
    const result = await calendar.book(body);
    if (!result.ok) {
      const status = result.code === "slot_taken" ? 409 : 400;
      return json({ error: { code: result.code, message: result.message } }, status);
    }
    const links = await bookingLinks(env, request, result.booking.id);
    let mail: MailResult = { guest: "skipped", host: "skipped" };
    try {
      mail = await sendConfirmation(env, host, result.booking, links);
    } catch (err) {
      console.error(JSON.stringify({ event: "confirm_mail_error", error: String(err) }));
      mail = { guest: "failed", host: "skipped" };
    }
    const mailStatus: MailStatus = mail.guest === "sent" || mail.host === "sent" ? "sent" : mail.guest;
    await setMailStatus(env.DB, result.booking.id, mailStatus);
    let google: MailStatus = "skipped";
    try {
      const created = await createGoogleEvent(env, host, result.booking);
      google = created.status;
      await setGoogleEvent(env.DB, result.booking.id, created.eventId, created.status);
    } catch (err) {
      console.error(JSON.stringify({ event: "google_book_error", error: String(err) }));
      google = "failed";
      await setGoogleEvent(env.DB, result.booking.id, null, "failed");
    }
    await enqueueReminder(env, result.booking);
    const booking = { ...result.booking, mailStatus, googleStatus: google };
    const response: BookResponse = { booking, mail, google, links };
    return json(response, 201);
  }

  if (pathname === "/api/google/status" && method === "GET") {
    await requireAdmin(env, request);
    return json(await googleStatus(env, request));
  }

  if (pathname === "/api/google/start" && method === "POST") {
    await requireAdmin(env, request);
    if (!googleEnabled(env)) throw new HttpError(503, "google_disabled", "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect Calendar.");
    const url = await startGoogleOAuth(env, request);
    return json({ url });
  }

  if (pathname === "/api/google/callback" && method === "GET") {
    if (!googleEnabled(env)) throw new HttpError(503, "google_disabled", "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect Calendar.");
    const result = await handleGoogleCallback(env, request);
    if (!result.ok) return adminRedirect(env, request, `google=error&reason=${encodeURIComponent(result.message)}`);
    return adminRedirect(env, request, "google=connected");
  }

  if (pathname === "/api/google/disconnect" && method === "POST") {
    await requireAdmin(env, request);
    await disconnectGoogle(env);
    return json({ connected: false });
  }

  if (pathname === "/api/admin/bookings" && method === "GET") {
    await requireAdmin(env, request);
    return json({ bookings: await listUpcoming(env.DB, host.id, new Date().toISOString()) });
  }

  const bookingMatch = pathname.match(/^\/api\/bookings\/([^/]+)(?:\/(.*))?$/);
  if (!bookingMatch) throw new HttpError(404, "not_found", "Unknown API route.");
  const bookingId = decodeURIComponent(bookingMatch[1]!);
  const rest = bookingMatch[2] ?? "";
  const booking = await getBooking(env.DB, bookingId);
  if (!booking) throw new HttpError(404, "not_found", "That booking is gone.");

  if (rest === "" && method === "GET") return json({ booking });

  if (rest === "ics" && method === "GET") {
    await requireSigned(env, "ics", bookingId, request);
    const ics = bookingIcs(host, booking, booking.status === "cancelled" ? "CANCEL" : "REQUEST", publicBase(env, request));
    return new Response(ics, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="punctual-${booking.id}.ics"`,
        "cache-control": "no-store",
      },
    });
  }

  if (rest === "cancel" && (method === "POST" || method === "GET")) {
    const admin = Boolean(env.ADMIN_API_KEY?.trim() && (await secretEquals(bearerToken(request) ?? "", env.ADMIN_API_KEY)));
    if (!admin) await requireSigned(env, "cancel", bookingId, request);
    const cancelled = await calendar.cancel(bookingId);
    if (cancelled.booking && cancelled.ok) {
      try {
        await sendCancelled(env, host, cancelled.booking);
      } catch (err) {
        console.error(JSON.stringify({ event: "cancel_mail_error", error: String(err) }));
      }
      try {
        await deleteGoogleEvent(env, booking.googleEventId);
      } catch (err) {
        console.error(JSON.stringify({ event: "google_cancel_error", error: String(err) }));
      }
    }
    const current = cancelled.booking ?? booking;
    if (method === "GET") {
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(/\/api\/bookings\/[^/]+\/cancel$/, "/cancel");
      url.search = `?id=${encodeURIComponent(bookingId)}&done=1`;
      return Response.redirect(url.toString(), 303);
    }
    return json({ booking: current, cancelled: cancelled.ok });
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}
