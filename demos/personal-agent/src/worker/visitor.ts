const VISITOR_ID = /^[a-z0-9]{16,32}$/;
const SIG = /^[a-f0-9]{64}$/;
const EXP = /^\d{11,15}$/;

/** Local-only HMAC key from `.dev.vars.example`. Production must set a different secret. */
export const DEV_HMAC_SECRET = "local-personal-agent-hmac-dev-only";

export type VisitorGrant = {
  id: string;
  expiresAt: number;
  sig: string;
};

export function parseVisitorId(value: unknown): string | null {
  return typeof value === "string" && VISITOR_ID.test(value) ? value : null;
}

export function tokenExpiryMs(ttlHours: number, now = Date.now()): number {
  const hours = Number.isFinite(ttlHours) ? Math.min(168, Math.max(1, Math.floor(ttlHours))) : 24;
  return now + hours * 3600 * 1000;
}

export function parseVisitorToken(token: string | null | undefined): VisitorGrant | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, expRaw, sig] = parts;
  if (!id || !expRaw || !sig) return null;
  if (!VISITOR_ID.test(id) || !EXP.test(expRaw) || !SIG.test(sig)) return null;
  const expiresAt = Number(expRaw);
  if (!Number.isFinite(expiresAt)) return null;
  return { id, expiresAt, sig };
}

export function tokenExpired(expiresAt: number, now = Date.now()): boolean {
  return expiresAt <= now;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i)! ^ right.charCodeAt(i)!;
  return mismatch === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

export async function signVisitor(secret: string, id: string, expiresAt: number): Promise<string> {
  const payload = `${id}.${expiresAt}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${hex(sig)}`;
}

export async function verifyVisitorToken(secret: string, token: string | null | undefined, now = Date.now()): Promise<string | null> {
  if (!secret || !token) return null;
  const parsed = parseVisitorToken(token);
  if (!parsed || tokenExpired(parsed.expiresAt, now)) return null;
  const expected = await signVisitor(secret, parsed.id, parsed.expiresAt);
  return timingEqual(token, expected) ? parsed.id : null;
}

export function hmacSecret(env: { VISITOR_HMAC_SECRET?: string; ENVIRONMENT?: string }): string | null {
  const secret = env.VISITOR_HMAC_SECRET?.trim() ?? "";
  if (!secret) return null;
  if (secret === DEV_HMAC_SECRET && env.ENVIRONMENT !== "local") return null;
  return secret;
}
