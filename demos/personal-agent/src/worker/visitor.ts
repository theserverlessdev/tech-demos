const VISITOR_ID = /^[a-z0-9]{16,32}$/;
const SIG = /^[a-f0-9]{64}$/;

/** Local-only HMAC key from `.dev.vars.example`. Production must set a different secret. */
export const DEV_HMAC_SECRET = "local-personal-agent-hmac-dev-only";

export function parseVisitorId(value: unknown): string | null {
  return typeof value === "string" && VISITOR_ID.test(value) ? value : null;
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

export async function signVisitor(secret: string, id: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  return `${id}.${hex(sig)}`;
}

export async function verifyVisitorToken(secret: string, token: string | null | undefined): Promise<string | null> {
  if (!secret || !token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!VISITOR_ID.test(id) || !SIG.test(sig)) return null;
  const expected = await signVisitor(secret, id);
  return timingEqual(token, expected) ? id : null;
}

export function hmacSecret(env: { VISITOR_HMAC_SECRET?: string; ENVIRONMENT?: string }): string | null {
  const secret = env.VISITOR_HMAC_SECRET?.trim() ?? "";
  if (!secret) return null;
  if (secret === DEV_HMAC_SECRET && env.ENVIRONMENT !== "local") return null;
  return secret;
}
