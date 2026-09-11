import { API_KEY_PREFIX } from "./limits";

const encoder = new TextEncoder();

export async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await sha256(value));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash both sides first, so the compare runs on equal lengths and leaks no length. */
export async function secretEquals(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/** 32 random bytes as base64url. This is the inbox capability. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Prefixed so logs and docs can tell an agent key from an inbox token without printing it. */
export function newApiKey(): string {
  return `${API_KEY_PREFIX}${newToken()}`;
}

export function newId(bytes = 10): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hostedMode(env: Env): boolean {
  return env.HOSTED_MODE === "true";
}

export async function isAdminKey(token: string | null, env: Env): Promise<boolean> {
  if (!token || !env.AGENT_API_KEY) return false;
  return secretEquals(token, env.AGENT_API_KEY);
}
