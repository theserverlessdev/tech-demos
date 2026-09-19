import { availabilityWindow } from "../shared/schedule";
import type { BusyInterval, GoogleStatus, Host, MailStatus } from "../shared/types";
import { GOOGLE_SCOPES, googleEnabled, googleRedirectUri, hostFromEnv, publicBase } from "./config";
import {
  deleteHostGoogle,
  getHostGoogle,
  isGoogleConnected,
  updateHostGoogleAccess,
  upsertHostGoogle,
} from "./db";
import { open, seal, tokenEncryptionSecret } from "./secretbox";
import { makeOauthState, parseOauthState, signingSecret } from "./sign";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const FREEBUSY = "https://www.googleapis.com/calendar/v3/freeBusy";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary";
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_KV = (nonce: string) => `oauth:${nonce}`;

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export function parseMockBusy(env: { GOOGLE_MOCK_BUSY?: string }): BusyInterval[] {
  const raw = env.GOOGLE_MOCK_BUSY?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is BusyInterval => {
      return Boolean(row && typeof row === "object" && typeof row.start === "string" && typeof row.end === "string");
    });
  } catch {
    return [];
  }
}

export async function googleStatus(env: Env, request: Request): Promise<GoogleStatus> {
  const host = hostFromEnv(env);
  const row = await getHostGoogle(env.DB, host.id);
  return {
    configured: googleEnabled(env),
    connected: Boolean(row),
    email: row?.email ?? null,
    redirectUri: googleRedirectUri(env, request),
    mock: parseMockBusy(env).length > 0,
  };
}

export async function startGoogleOAuth(env: Env, request: Request): Promise<string> {
  if (!googleEnabled(env)) throw new Error("google_disabled");
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const exp = Date.now() + STATE_TTL_MS;
  await env.CACHE.put(STATE_KV(nonce), "1", { expirationTtl: 600 });
  const state = await makeOauthState(signingSecret(env).secret, nonce, exp);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID.trim(),
    redirect_uri: googleRedirectUri(env, request),
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  return `${AUTH}?${params}`;
}

export async function handleGoogleCallback(env: Env, request: Request): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!googleEnabled(env)) return { ok: false, message: "google_disabled" };
  const url = new URL(request.url);
  const err = url.searchParams.get("error");
  if (err) return { ok: false, message: err };
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const nonce = await parseOauthState(signingSecret(env).secret, state);
  if (!nonce || !code) return { ok: false, message: "invalid_state" };
  const seen = await env.CACHE.get(STATE_KV(nonce));
  if (!seen) return { ok: false, message: "state_used" };
  await env.CACHE.delete(STATE_KV(nonce));

  const redirectUri = googleRedirectUri(env, request);
  const tokens = await exchangeCode(env, code, redirectUri);
  if (!tokens.access_token) return { ok: false, message: tokens.error_description || tokens.error || "token_failed" };
  if (!tokens.refresh_token) return { ok: false, message: "missing_refresh_token" };

  const email = await fetchPrimaryEmail(tokens.access_token);
  const box = tokenEncryptionSecret(env);
  const host = hostFromEnv(env);
  const now = Date.now();
  const expiresAt = now + Math.max(60, Number(tokens.expires_in ?? 3600) - 60) * 1000;
  await upsertHostGoogle(env.DB, {
    hostId: host.id,
    email: email || "primary",
    accessTokenEnc: await seal(box.secret, tokens.access_token),
    refreshTokenEnc: await seal(box.secret, tokens.refresh_token),
    tokenExpiresAt: expiresAt,
    scopes: GOOGLE_SCOPES,
    now,
  });
  await env.CACHE.delete(`avail:${host.id}`);
  return { ok: true };
}

export async function disconnectGoogle(env: Env): Promise<void> {
  const host = hostFromEnv(env);
  await deleteHostGoogle(env.DB, host.id);
  await env.CACHE.delete(`avail:${host.id}`);
}

async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(12_000),
  });
  return (await res.json()) as TokenResponse;
}

async function refreshAccess(env: Env, refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(12_000),
  });
  return (await res.json()) as TokenResponse;
}

async function fetchPrimaryEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(CALENDAR, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string };
    return data.id?.includes("@") ? data.id : null;
  } catch {
    return null;
  }
}

export async function accessToken(env: Env): Promise<string | null> {
  const host = hostFromEnv(env);
  const row = await getHostGoogle(env.DB, host.id);
  if (!row) return null;
  const box = tokenEncryptionSecret(env);
  try {
    if (row.token_expires_at > Date.now() + 15_000) return await open(box.secret, row.access_token_enc);
    const refresh = await open(box.secret, row.refresh_token_enc);
    const next = await refreshAccess(env, refresh);
    if (!next.access_token) {
      if (next.error === "invalid_grant") await deleteHostGoogle(env.DB, host.id);
      console.error(JSON.stringify({ event: "google_refresh_failed", error: next.error, detail: next.error_description }));
      return null;
    }
    const expiresAt = Date.now() + Math.max(60, Number(next.expires_in ?? 3600) - 60) * 1000;
    await updateHostGoogleAccess(env.DB, host.id, await seal(box.secret, next.access_token), expiresAt, Date.now());
    return next.access_token;
  } catch (err) {
    console.error(JSON.stringify({ event: "google_token_error", error: String(err) }));
    return null;
  }
}

export async function queryFreeBusy(
  env: Env,
  host: Host,
  window = availabilityWindow(host),
): Promise<{ ok: true; busy: BusyInterval[] } | { ok: false }> {
  const token = await accessToken(env);
  if (!token) return { ok: false };
  try {
    const res = await fetch(FREEBUSY, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        timeZone: host.timezone,
        items: [{ id: "primary" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(JSON.stringify({ event: "google_freebusy_failed", status: res.status, detail: detail.slice(0, 400) }));
      return { ok: false };
    }
    const data = (await res.json()) as {
      calendars?: Record<string, { busy?: BusyInterval[] }>;
    };
    const busy = Object.values(data.calendars ?? {}).flatMap((cal) => cal.busy ?? []);
    return { ok: true, busy };
  } catch (err) {
    console.error(JSON.stringify({ event: "google_freebusy_error", error: String(err) }));
    return { ok: false };
  }
}

export async function loadBusyIntervals(env: Env, host: Host): Promise<{ google: "off" | "merged" | "failed"; busy: BusyInterval[] }> {
  const connected = await isGoogleConnected(env.DB, host.id);
  if (connected) {
    const fb = await queryFreeBusy(env, host);
    if (fb.ok) return { google: "merged", busy: fb.busy };
    return { google: "failed", busy: [] };
  }
  const mock = parseMockBusy(env);
  if (mock.length) return { google: "merged", busy: mock };
  return { google: "off", busy: [] };
}

export async function createGoogleEvent(
  env: Env,
  host: Host,
  booking: { guestName: string; guestEmail: string; slotStart: string; slotEnd: string },
): Promise<{ status: MailStatus; eventId: string | null }> {
  if (!(await isGoogleConnected(env.DB, host.id))) return { status: "skipped", eventId: null };
  const token = await accessToken(env);
  if (!token) return { status: "failed", eventId: null };
  const body = {
    summary: `${host.title} with ${booking.guestName}`,
    description: `Booked via Punctual.\nGuest: ${booking.guestName} <${booking.guestEmail}>`,
    start: { dateTime: booking.slotStart, timeZone: host.timezone },
    end: { dateTime: booking.slotEnd, timeZone: host.timezone },
    attendees: [{ email: booking.guestEmail, displayName: booking.guestName }],
  };
  try {
    let res = await fetch(`${CALENDAR}/events?sendUpdates=none`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 403) {
      const { attendees: _a, ...noGuests } = body;
      res = await fetch(`${CALENDAR}/events?sendUpdates=none`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(noGuests),
        signal: AbortSignal.timeout(12_000),
      });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(JSON.stringify({ event: "google_event_failed", status: res.status, detail: detail.slice(0, 400) }));
      return { status: "failed", eventId: null };
    }
    const data = (await res.json()) as { id?: string };
    return { status: "sent", eventId: data.id ?? null };
  } catch (err) {
    console.error(JSON.stringify({ event: "google_event_error", error: String(err) }));
    return { status: "failed", eventId: null };
  }
}

export async function deleteGoogleEvent(env: Env, eventId: string | null): Promise<void> {
  if (!eventId) return;
  const token = await accessToken(env);
  if (!token) return;
  try {
    const res = await fetch(`${CALENDAR}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      const detail = await res.text().catch(() => "");
      console.error(JSON.stringify({ event: "google_event_delete_failed", status: res.status, detail: detail.slice(0, 300) }));
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "google_event_delete_error", error: String(err) }));
  }
}

export function adminRedirect(env: Env, request: Request, query: string): Response {
  const base = publicBase(env, request);
  return Response.redirect(`${base}/admin?${query}`, 303);
}
