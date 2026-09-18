import type { ReminderMessage } from "../shared/types";
import { handleApi, HttpError } from "./api";
import { Calendar } from "./calendar";
import { delaySecondsUntil, hostFromEnv, publicBase } from "./config";
import { getBooking, setReminderStatus } from "./db";
import { sendReminder } from "./mail";
import { signingSecret, signToken } from "./sign";

export { Calendar };

/** The hub serves this demo under a path. The subdomain serves it at the root. */
const BASE_PATH = "/demos/punctual";

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "frame-src https://challenges.cloudflare.com",
  "connect-src 'self' https://cloudflareinsights.com https://challenges.cloudflare.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status, headers: { "cache-control": "no-store" } });
  }
  console.error(JSON.stringify({ event: "api_error", error: String(err), stack: err instanceof Error ? err.stack : undefined }));
  return Response.json({ error: { code: "internal", message: "The server failed. Try again." } }, { status: 500 });
}

function assetPath(path: string): string {
  if (path === "/admin" || path === "/admin/") return "/admin.html";
  if (path === "/cancel" || path === "/cancel/") return "/cancel.html";
  return path === "/" ? "/index.html" : path;
}

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetPath(path);
  let res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  if (res.status === 404 && !path.startsWith("/assets/")) {
    assetUrl.pathname = "/index.html";
    res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  }
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  if ((headers.get("content-type") ?? "").startsWith("text/html")) headers.set("content-security-policy", PAGE_CSP);
  return new Response(res.body, { status: res.status, headers });
}

async function queueLinks(env: Env, bookingId: string): Promise<{ ics: string; cancel: string }> {
  const dummy = new Request(env.PUBLIC_ORIGIN?.trim() || "https://punctual.tech-demos.theserverless.dev/");
  const base = publicBase(env, dummy);
  const { secret } = signingSecret(env);
  const ics = await signToken(secret, "ics", bookingId);
  const cancel = await signToken(secret, "cancel", bookingId);
  return {
    ics: `${base}/api/bookings/${bookingId}/ics?t=${encodeURIComponent(ics)}`,
    cancel: `${base}/cancel?id=${encodeURIComponent(bookingId)}&t=${encodeURIComponent(cancel)}`,
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;

    if (path === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }
    if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length);

    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (err) {
        return errorResponse(err);
      }
    }

    return serveAsset(request, env, path);
  },

  async queue(batch, env): Promise<void> {
    const host = hostFromEnv(env);
    for (const message of batch.messages) {
      try {
        const body = message.body as ReminderMessage;
        const booking = await getBooking(env.DB, body.bookingId);
        if (!booking || booking.status !== "confirmed") {
          if (booking?.reminderStatus === "queued") {
            await setReminderStatus(env.DB, booking.id, "skipped", "Booking cancelled before reminder.", Date.now());
          }
          message.ack();
          continue;
        }
        if (booking.reminderStatus !== "queued") {
          message.ack();
          continue;
        }
        const wait = delaySecondsUntil(body.sendAt);
        if (wait > 2) {
          await env.REMINDERS.send(body, { delaySeconds: wait });
          message.ack();
          continue;
        }
        const links = await queueLinks(env, booking.id);
        const status = await sendReminder(env, host, booking, links);
        const detail =
          status === "sent"
            ? `Reminder email sent to ${booking.guestEmail}`
            : status === "skipped"
              ? "Reminder skipped (no RESEND_API_KEY or MAIL_FROM)."
              : "Reminder email failed.";
        await setReminderStatus(env.DB, booking.id, status, detail, Date.now());
        console.log(JSON.stringify({ event: "reminder", bookingId: booking.id, status }));
        message.ack();
      } catch (err) {
        console.error(JSON.stringify({ event: "reminder_failed", error: String(err) }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
