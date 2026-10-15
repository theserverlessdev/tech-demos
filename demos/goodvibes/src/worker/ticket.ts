import { JOIN_TICKET_TTL_MS } from "../shared/types";

type TicketBody = { r: string; e: number; n: string };

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(raw: string): Uint8Array | null {
  try {
    const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function mintJoinTicket(secret: string, room: string, now = Date.now()): Promise<{ ticket: string; expiresAt: number }> {
  const expiresAt = now + JOIN_TICKET_TTL_MS;
  const body: TicketBody = { r: room, e: expiresAt, n: crypto.randomUUID() };
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  return { ticket: `${b64urlEncode(payload)}.${b64urlEncode(sig)}`, expiresAt };
}

export async function verifyJoinTicket(secret: string, ticket: string, room: string, now = Date.now()): Promise<boolean> {
  const parts = ticket.split(".");
  if (parts.length !== 2) return false;
  const payloadBytes = b64urlDecode(parts[0]!);
  const sigBytes = b64urlDecode(parts[1]!);
  if (!payloadBytes || !sigBytes) return false;
  let body: TicketBody;
  try {
    body = JSON.parse(new TextDecoder().decode(payloadBytes)) as TicketBody;
  } catch {
    return false;
  }
  if (body.r !== room || typeof body.e !== "number" || typeof body.n !== "string") return false;
  if (body.e < now) return false;
  const key = await hmacKey(secret);
  return crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes);
}

export async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
