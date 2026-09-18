import { DEFAULT_HOST, parseClock, parseWeekdays, timezoneLabel } from "../shared/schedule";
import type { Host } from "../shared/types";

export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
export const QUEUE_MAX_DELAY_SEC = 24 * 60 * 60;

type HostVars = {
  HOST_ID?: string;
  HOST_DISPLAY_NAME?: string;
  HOST_TITLE?: string;
  HOST_TZ?: string;
  SLOT_MINUTES?: string;
  DAY_START?: string;
  DAY_END?: string;
  WEEKDAYS?: string;
};

export function hostFromEnv(env: HostVars): Host {
  const start = parseClock(env.DAY_START ?? "09:00", DEFAULT_HOST.startHour, DEFAULT_HOST.startMinute);
  const end = parseClock(env.DAY_END ?? "17:00", DEFAULT_HOST.endHour, DEFAULT_HOST.endMinute);
  const slotMinutes = Number(env.SLOT_MINUTES ?? DEFAULT_HOST.slotMinutes);
  const timezone = env.HOST_TZ?.trim() || DEFAULT_HOST.timezone;
  return {
    id: env.HOST_ID?.trim() || DEFAULT_HOST.id,
    name: env.HOST_DISPLAY_NAME?.trim() || DEFAULT_HOST.name,
    title: env.HOST_TITLE?.trim() || DEFAULT_HOST.title,
    timezone,
    timezoneLabel: timezoneLabel(timezone),
    slotMinutes: Number.isFinite(slotMinutes) && slotMinutes >= 5 && slotMinutes <= 240 ? slotMinutes : DEFAULT_HOST.slotMinutes,
    startHour: start.hour,
    startMinute: start.minute,
    endHour: end.hour,
    endMinute: end.minute,
    weekdays: parseWeekdays(env.WEEKDAYS),
    horizonDays: DEFAULT_HOST.horizonDays,
  };
}

export function publicBase(env: { PUBLIC_ORIGIN?: string }, request: Request): string {
  const configured = env.PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(request.url);
  const path = url.pathname.startsWith("/demos/punctual") ? "/demos/punctual" : "";
  return `${url.origin}${path}`;
}

export function delaySecondsUntil(sendAt: number, now = Date.now()): number {
  const remaining = Math.floor((sendAt - now) / 1000);
  if (remaining <= 0) return 0;
  return Math.min(remaining, QUEUE_MAX_DELAY_SEC);
}

export function reminderSendAt(slotStartIso: string, now = Date.now()): number {
  const start = Date.parse(slotStartIso);
  if (!Number.isFinite(start)) return now;
  return Math.max(now, start - REMINDER_LEAD_MS);
}

export function mailFrom(env: { MAIL_FROM?: string; MAIL_FROM_NAME?: string }): string | null {
  const from = env.MAIL_FROM?.trim();
  if (!from || !from.includes("@")) return null;
  const name = env.MAIL_FROM_NAME?.trim();
  return name ? `${name} <${from}>` : from;
}

export function resendEnabled(env: { RESEND_API_KEY?: string; MAIL_FROM?: string }): boolean {
  return Boolean(env.RESEND_API_KEY?.trim() && mailFrom(env));
}

export function turnstileEnabled(env: { TURNSTILE_SECRET_KEY?: string; TURNSTILE_SITE_KEY?: string }): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY?.trim() && env.TURNSTILE_SITE_KEY?.trim());
}
