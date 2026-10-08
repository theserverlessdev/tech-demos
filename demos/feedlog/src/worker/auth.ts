import { isLoopback } from "./http";
import { LOOPBACK_ADMIN_TOKEN } from "./limits";

const encoder = new TextEncoder();

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/** Hash both sides first so the compare is equal length and leaks no secret length. */
export async function secretEquals(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? "";
}

export function adminToken(env: Env, request: Request): string | null {
  const set = env.ADMIN_TOKEN?.trim();
  if (set) return set;
  if (isLoopback(request)) return LOOPBACK_ADMIN_TOKEN;
  return null;
}
