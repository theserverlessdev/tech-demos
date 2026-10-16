import { getApproveTokenByHash, getSettings, insertApproveToken } from "./db";
import type { ApproveTokenRow } from "./types";
import { base64Url, newId, sha256Hex } from "./util";

const DEFAULT_TTL_HOURS = 24 * 7;
const MAX_TTL_HOURS = 24 * 30;
const MAX_TOKEN_CHARS = 128;

export function approveTtlMs(env: Env): number {
  const parsed = Number(env.APPROVE_LINK_TTL_HOURS ?? DEFAULT_TTL_HOURS);
  const hours = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_TTL_HOURS) : DEFAULT_TTL_HOURS;
  return hours * 60 * 60 * 1000;
}

/** Issues a raw token when approve links are on. The caller shows it once. Null means links are off. */
export async function issueApproveToken(env: Env, draftId: string, now = Date.now()): Promise<string | null> {
  const settings = await getSettings(env.DB);
  if (settings.approve_links !== 1) return null;
  const raw = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  await insertApproveToken(env.DB, {
    id: newId(),
    draft_id: draftId,
    token_hash: await sha256Hex(raw),
    expires_at: now + approveTtlMs(env),
    created_at: now,
  });
  return raw;
}

export function boundToken(value: string): string {
  return value.length > MAX_TOKEN_CHARS ? value.slice(0, MAX_TOKEN_CHARS) : value;
}

/** Fixed-length compare. Both sides are hashed so a short token still takes one SHA-256. */
export async function tokensMatch(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(boundToken(left)), sha256Hex(boundToken(right))]);
  return crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}

export async function lookupPresentedToken(env: Env, raw: string): Promise<ApproveTokenRow | null> {
  return getApproveTokenByHash(env.DB, await sha256Hex(boundToken(raw)));
}
