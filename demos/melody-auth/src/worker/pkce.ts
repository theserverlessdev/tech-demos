import { sha256, timingSafeEqual, toBase64Url } from "./encoding";

const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function challengeShape(value: string): boolean {
  return CHALLENGE.test(value);
}

export function verifierShape(value: string): boolean {
  return VERIFIER.test(value);
}

export async function s256Challenge(verifier: string): Promise<string> {
  return toBase64Url(await sha256(verifier));
}

export async function verifyS256(verifier: string, challenge: string): Promise<boolean> {
  if (!verifierShape(verifier) || !challengeShape(challenge)) return false;
  return timingSafeEqual(await s256Challenge(verifier), challenge);
}
