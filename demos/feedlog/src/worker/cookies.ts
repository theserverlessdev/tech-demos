import { GATE_TTL_SECONDS } from "./limits";

export function cookiePath(url: URL): string {
  return url.pathname.startsWith("/demos/feedlog") ? "/demos/feedlog" : "/";
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export function setCookie(url: URL, name: string, value: string, maxAge: number): string {
  const parts = [`${name}=${value}`, `Path=${cookiePath(url)}`, `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (url.protocol === "https:") parts.push("Secure");
  return parts.join("; ");
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(value)) return null;
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + pad);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

export type GatePayload = { nonce: string; exp: number };

export async function signGate(secret: string, visitorId: string, nonce: string, now: number): Promise<string> {
  const exp = now + GATE_TTL_SECONDS * 1000;
  const payload = `v2.${exp}.${visitorId}.${nonce}`;
  return `${payload}.${bytesToB64url(await hmac(secret, payload))}`;
}

export async function readGate(secret: string, cookie: string | null, visitorId: string, now: number): Promise<GatePayload | null> {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 5 || parts[0] !== "v2") return null;
  const exp = Number(parts[1]);
  const visitor = parts[2] ?? "";
  const nonce = parts[3] ?? "";
  const sig = b64urlToBytes(parts[4] ?? "");
  if (!sig || !Number.isFinite(exp) || visitor !== visitorId || !/^[a-f0-9]{32}$/.test(nonce)) return null;
  if (exp < now || exp > now + GATE_TTL_SECONDS * 1000 + 5_000) return null;
  const expected = await hmac(secret, `v2.${exp}.${visitor}.${nonce}`);
  if (expected.byteLength !== sig.byteLength) return null;
  if (!crypto.subtle.timingSafeEqual(expected, sig)) return null;
  return { nonce, exp };
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function visitorFrom(request: Request): { id: string; fresh: boolean } {
  const existing = readCookie(request, "fl_vid");
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return { id: existing, fresh: false };
  return { id: randomHex(16), fresh: true };
}
