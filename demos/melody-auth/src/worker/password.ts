import { PBKDF2_ITERATIONS } from "../shared/types";
import { bytes, fromHex, randomBytes, toHex } from "./encoding";

export async function hashPassword(password: string, salt = randomBytes(16)): Promise<{ hash: string; salt: string }> {
  const key = await crypto.subtle.importKey("raw", bytes(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: toHex(new Uint8Array(bits)), salt: toHex(salt) };
}

export async function verifyPassword(password: string, hash: string, saltHex: string): Promise<boolean> {
  const expected = await hashPassword(password, fromHex(saltHex));
  if (expected.hash.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expected.hash.charCodeAt(i);
  return diff === 0;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailShape(email: string): boolean {
  return /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/.test(email);
}

export function passwordShape(password: string): boolean {
  return password.length >= 8 && password.length <= 128;
}

/** First local char + *** @ first domain char + *** . rest of domain. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.indexOf(".");
  if (dot < 1) return `${local[0]}***@***`;
  return `${local[0]}***@${domain[0]}***.${domain.slice(dot + 1)}`;
}
