import { formatSlotRange } from "../shared/schedule";
import type { Booking, Host, MailStatus } from "../shared/types";
import { mailFrom, resendEnabled } from "./config";
import { bookingIcs } from "./ics";

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function wrap(body: string): string {
  return `<!doctype html>
<html><body style="margin:0;background:#0e0e11;color:#c9c9c4;font-family:Georgia,serif">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <p style="color:#e2622e;letter-spacing:.12em;font:600 11px/1 sans-serif;text-transform:uppercase">Punctual</p>
    ${body}
    <p style="color:#8a8a85;font:13px/1.5 sans-serif;margin-top:32px">Inspired by punctual.sh — a small Workers demo.</p>
  </div>
</body></html>`;
}

async function sendResend(
  env: Env,
  input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    ics?: { filename: string; content: string; method: "REQUEST" | "CANCEL" };
  },
): Promise<MailStatus> {
  if (!resendEnabled(env)) return "skipped";
  const from = mailFrom(env);
  if (!from) return "skipped";
  const attachments = input.ics
    ? [
        {
          filename: input.ics.filename,
          content: toBase64(input.ics.content),
          content_type: `text/calendar; charset=utf-8; method=${input.ics.method}`,
        },
      ]
    : undefined;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        attachments,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(JSON.stringify({ event: "resend_failed", status: res.status, detail: detail.slice(0, 400) }));
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error(JSON.stringify({ event: "resend_error", error: String(err) }));
    return "failed";
  }
}

function originFromIcsLink(ics: string): string {
  const idx = ics.indexOf("/api/");
  return idx >= 0 ? ics.slice(0, idx) : ics;
}

export async function sendConfirmation(
  env: Env,
  host: Host,
  booking: Booking,
  links: { ics: string; cancel: string },
): Promise<{ guest: MailStatus; host: MailStatus }> {
  const when = formatSlotRange(booking.slotStart, booking.slotEnd, host);
  const origin = originFromIcsLink(links.ics);
  const ics = bookingIcs(host, booking, "REQUEST", origin);
  const text = `${host.title} with ${host.name}\n${when}\nAdd to calendar: ${links.ics}\nCancel: ${links.cancel}`;
  const html = wrap(`
    <h1 style="color:#e8e8e4;font:700 28px/1.15 sans-serif">You're booked.</h1>
    <p style="font:16px/1.5 sans-serif;color:#e8e8e4">${when}</p>
    <p style="font:15px/1.5 sans-serif">With ${host.name}. An .ics invite is attached so you can add it to your calendar.</p>
    <p><a href="${links.ics}" style="color:#e2622e">Download calendar file</a> · <a href="${links.cancel}" style="color:#e2622e">Cancel this booking</a></p>
  `);
  const guest = await sendResend(env, {
    to: booking.guestEmail,
    subject: `${host.title} with ${host.name} — ${when}`,
    html,
    text,
    ics: { filename: "punctual.ics", content: ics, method: "REQUEST" },
  });
  const notify = env.HOST_NOTIFY_EMAIL?.trim();
  let hostMail: MailStatus = "skipped";
  if (notify) {
    hostMail = await sendResend(env, {
      to: notify,
      subject: `New booking: ${booking.guestName} — ${when}`,
      html: wrap(`<h1 style="color:#e8e8e4;font:700 24px/1.15 sans-serif">New booking</h1>
        <p style="font:15px/1.5 sans-serif">${booking.guestName} &lt;${booking.guestEmail}&gt;<br>${when}</p>`),
      text: `New booking: ${booking.guestName} <${booking.guestEmail}>\n${when}`,
    });
  }
  return { guest, host: hostMail };
}

export async function sendReminder(env: Env, host: Host, booking: Booking, links: { ics: string; cancel: string }): Promise<MailStatus> {
  const when = formatSlotRange(booking.slotStart, booking.slotEnd, host);
  return sendResend(env, {
    to: booking.guestEmail,
    subject: `Reminder: ${host.title} with ${host.name} tomorrow`,
    html: wrap(`<h1 style="color:#e8e8e4;font:700 24px/1.15 sans-serif">See you soon.</h1>
      <p style="font:16px/1.5 sans-serif">${when}</p>
      <p><a href="${links.ics}" style="color:#e2622e">Calendar file</a> · <a href="${links.cancel}" style="color:#e2622e">Cancel</a></p>`),
    text: `Reminder: ${when}\n${links.ics}\nCancel: ${links.cancel}`,
    ics: { filename: "punctual.ics", content: bookingIcs(host, booking, "REQUEST", originFromIcsLink(links.ics)), method: "REQUEST" },
  });
}

export async function sendCancelled(env: Env, host: Host, booking: Booking): Promise<MailStatus> {
  const when = formatSlotRange(booking.slotStart, booking.slotEnd, host);
  return sendResend(env, {
    to: booking.guestEmail,
    subject: `Cancelled: ${host.title} with ${host.name}`,
    html: wrap(`<h1 style="color:#e8e8e4;font:700 24px/1.15 sans-serif">Booking cancelled.</h1>
      <p style="font:16px/1.5 sans-serif">${when} is free again.</p>`),
    text: `Cancelled: ${when}`,
    ics: { filename: "punctual-cancel.ics", content: bookingIcs(host, booking, "CANCEL", ""), method: "CANCEL" },
  });
}
