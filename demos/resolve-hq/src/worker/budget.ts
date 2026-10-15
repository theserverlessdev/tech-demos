import { LIMITS } from "../shared/limits";
import { HttpError } from "./errors";
import { clientIp } from "./origin";

export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseCap(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function hashIpKey(ip: string, secret: string): Promise<string> {
  if (!secret) throw new HttpError(503, "budget_unconfigured", "Drafts are off until SESSION_SECRET is set.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`resolve-hq-ip-v1:${ip}`));
  return hex(sig);
}

export async function usedToday(env: Env, day = dayKey()): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE day = ?`).bind(day).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function claimDraft(env: Env, request: Request, now = Date.now()): Promise<string> {
  const secret = env.SESSION_SECRET?.trim() ?? "";
  const ipKey = await hashIpKey(clientIp(request), secret);
  const day = dayKey(now);
  const id = crypto.randomUUID();
  const dailyCap = parseCap(env.DAILY_DRAFT_CAP, LIMITS.dailyDraftCap);
  const ipCap = parseCap(env.IP_DRAFT_CAP, LIMITS.ipDraftCap);
  const result = await env.DB.prepare(
    `INSERT INTO drafts (id, day, ip_key, created_at)
     SELECT ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM drafts WHERE day = ?) < ?
       AND (SELECT COUNT(*) FROM drafts WHERE day = ? AND ip_key = ?) < ?`,
  )
    .bind(id, day, ipKey, now, day, dailyCap, day, ipKey, ipCap)
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    const globalUsed = await usedToday(env, day);
    if (globalUsed >= dailyCap) {
      throw new HttpError(503, "daily", "The shared Workers AI draft budget for today is used up. Try again tomorrow.");
    }
    throw new HttpError(429, "ip_daily", "This network has used its draft budget for today.");
  }
  return id;
}
