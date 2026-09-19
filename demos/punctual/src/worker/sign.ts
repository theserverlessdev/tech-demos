const encoder = new TextEncoder();

async function hmacBytes(secret: string, payload: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(payload));
}

function toBase64Url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function signingSecret(env: { SIGNING_SECRET?: string; HOST_ID?: string }): { secret: string; mode: "secret" | "dev-fallback" } {
  const set = env.SIGNING_SECRET?.trim();
  if (set) return { secret: set, mode: "secret" };
  return { secret: `punctual-dev:${env.HOST_ID || "ankur"}`, mode: "dev-fallback" };
}

export async function signToken(secret: string, purpose: "ics" | "cancel" | "google", bookingId: string): Promise<string> {
  return toBase64Url(await hmacBytes(secret, `${purpose}:${bookingId}`));
}

export async function verifyToken(
  secret: string,
  purpose: "ics" | "cancel" | "google",
  bookingId: string,
  token: string,
): Promise<boolean> {
  if (!token || token.length > 128) return false;
  const expected = await signToken(secret, purpose, bookingId);
  if (expected.length !== token.length) return false;
  const a = encoder.encode(expected);
  const b = encoder.encode(token);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

export async function secretEquals(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function makeOauthState(secret: string, nonce: string, exp: number): Promise<string> {
  const payload = `${nonce}.${exp}`;
  const sig = await signToken(secret, "google", payload);
  return `${payload}.${sig}`;
}

export async function parseOauthState(secret: string, state: string): Promise<string | null> {
  const last = state.lastIndexOf(".");
  if (last <= 0) return null;
  const payload = state.slice(0, last);
  const sig = state.slice(last + 1);
  const dot = payload.indexOf(".");
  if (dot <= 0) return null;
  const nonce = payload.slice(0, dot);
  const exp = Number(payload.slice(dot + 1));
  if (!nonce || !Number.isFinite(exp) || exp < Date.now()) return null;
  if (!(await verifyToken(secret, "google", payload, sig))) return null;
  return nonce;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}
