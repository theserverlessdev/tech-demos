import { sha256Hex, timingSafeEqual } from "./encoding";

export async function hashClientSecret(secret: string): Promise<string> {
  return sha256Hex(secret);
}

export async function clientSecretMatches(secret: string, hash: string): Promise<boolean> {
  if (!secret || !hash) return false;
  const got = await hashClientSecret(secret);
  if (got.length !== hash.length) return false;
  return timingSafeEqual(got, hash);
}
