import { bytesToHex, hexToBytes, randomBytes, sha256Hex, timingSafeEqual } from "./crypto";

const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 10000;

export type BasicCredentials = { username: string; password: string };

export function parseBasic(header: string | null): BasicCredentials | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

export async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      key,
      256,
    ),
  );
  return bytesToHex(bits);
}

export async function newPasswordRecord(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16);
  return { salt: bytesToHex(salt), hash: await hashPassword(password, salt) };
}

const DUMMY_SALT = new Uint8Array(16).fill(0x11);
let dummyHash: string | null = null;

async function dummy(): Promise<string> {
  dummyHash ??= await hashPassword("dummy-password", DUMMY_SALT);
  return dummyHash;
}

/** Always runs PBKDF2, including when the drive does not exist. */
export async function passwordMatches(password: string, saltHex: string | null, hashHex: string | null): Promise<boolean> {
  const salt = saltHex ? hexToBytes(saltHex) : null;
  const expected = hashHex ? hexToBytes(hashHex) : null;
  const useDummy = !salt || !expected;
  const derived = await hashPassword(password, useDummy ? DUMMY_SALT : salt);
  const derivedBytes = hexToBytes(derived);
  const expectedBytes = useDummy ? hexToBytes(await dummy()) : expected;
  if (!derivedBytes || !expectedBytes) return false;
  return timingSafeEqual(derivedBytes, expectedBytes);
}

export async function hashSession(token: string): Promise<string> {
  return sha256Hex(encoder.encode(token));
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, secure: boolean, maxAge: number): string {
  const parts = [`r2drive_session=${token}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
