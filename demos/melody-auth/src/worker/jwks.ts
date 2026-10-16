import { KEY_ROTATE_MS, KEY_VERIFY_WINDOW_MS } from "../shared/types";
import { HttpError } from "./errors";
import {
  generateEs256,
  importSigningKey,
  parsePrivateJwk,
  publicJwkFromPrivate,
  type EcPrivateJwk,
  type PublicJwk,
} from "./jwt";
import { isLocalEnv } from "./origin";
import { randomId } from "./encoding";

const RING_KEY = "jwks:ring";
export const DEMO_KID = "melody-demo-1";
export const DEMO_D = "p2rJ5XiDRi5pLLG9gzH4qoXbs2GKJ5KN3jruLjfILW0";

export type SigningContext = {
  kid: string;
  privateJwk: EcPrivateJwk;
  publicJwk: PublicJwk;
  key: CryptoKey;
};

type KeyRecord = {
  kid: string;
  privateJwk: EcPrivateJwk;
  publicJwk: PublicJwk;
  createdAt: number;
  retireAt: number | null;
};

type Ring = { currentKid: string; keys: KeyRecord[] };

let isolateCtx: SigningContext | null = null;
let isolateRing: Ring | null = null;

export function isCommittedDemoKey(jwk: { kid?: string; d?: string }): boolean {
  return jwk.kid === DEMO_KID || jwk.d === DEMO_D;
}

export function rejectDemoSigningKey(jwk: { kid?: string; d?: string }, env: { ENVIRONMENT?: string }): boolean {
  return isCommittedDemoKey(jwk) && !isLocalEnv(env);
}

async function bootstrapRing(env: Env, now: number): Promise<Ring> {
  const raw = env.AUTH_PRIVATE_JWK?.trim() ?? "";
  if (!raw) throw new HttpError(503, "misconfigured", "The server failed. Try again.");
  let privateJwk: EcPrivateJwk;
  try {
    privateJwk = parsePrivateJwk(raw);
  } catch {
    throw new HttpError(503, "misconfigured", "The server failed. Try again.");
  }
  if (rejectDemoSigningKey(privateJwk, env)) {
    throw new HttpError(503, "misconfigured", "The server failed. Try again.");
  }
  const publicJwk = publicJwkFromPrivate(privateJwk);
  return {
    currentKid: publicJwk.kid,
    keys: [{ kid: publicJwk.kid, privateJwk, publicJwk, createdAt: now, retireAt: null }],
  };
}

async function loadRing(env: Env, now: number): Promise<Ring> {
  if (isolateRing) return isolateRing;
  try {
    const stored = (await env.KEYS.get(RING_KEY, "json")) as Ring | null;
    if (stored?.currentKid && Array.isArray(stored.keys) && stored.keys.length) {
      isolateRing = stored;
      return stored;
    }
  } catch {
    // fall through to secret bootstrap
  }
  const ring = await bootstrapRing(env, now);
  try {
    await env.KEYS.put(RING_KEY, JSON.stringify(ring));
  } catch {
    // best-effort
  }
  isolateRing = ring;
  return ring;
}

export async function signingContext(env: Env): Promise<SigningContext> {
  const now = Date.now();
  const ring = await loadRing(env, now);
  const current = ring.keys.find((key) => key.kid === ring.currentKid) ?? ring.keys[0];
  if (!current) throw new HttpError(503, "misconfigured", "The server failed. Try again.");
  if (rejectDemoSigningKey(current.privateJwk, env)) {
    throw new HttpError(503, "misconfigured", "The server failed. Try again.");
  }
  if (isolateCtx && isolateCtx.kid === current.kid && isolateCtx.privateJwk.d === current.privateJwk.d) {
    return isolateCtx;
  }
  isolateCtx = {
    kid: current.kid,
    privateJwk: current.privateJwk,
    publicJwk: current.publicJwk,
    key: await importSigningKey(current.privateJwk),
  };
  return isolateCtx;
}

export async function jwksDocument(env: Env): Promise<{ keys: PublicJwk[] }> {
  const now = Date.now();
  const ring = await loadRing(env, now);
  const keys = ring.keys
    .filter((key) => key.retireAt == null || key.retireAt + KEY_VERIFY_WINDOW_MS > now)
    .map((key) => key.publicJwk);
  if (keys.length) return { keys };
  const ctx = await signingContext(env);
  return { keys: [ctx.publicJwk] };
}

export async function rotateSigningKeys(env: Env, now = Date.now()): Promise<{ kid: string; rotated: boolean }> {
  const ring = await loadRing(env, now);
  const current = ring.keys.find((key) => key.kid === ring.currentKid);
  if (current && now - current.createdAt < KEY_ROTATE_MS) return { kid: current.kid, rotated: false };
  if (current && rejectDemoSigningKey(current.privateJwk, env)) return { kid: current.kid, rotated: false };
  const next = await generateEs256(randomId("kid").replace("kid_", "melody-"));
  const publicJwk = publicJwkFromPrivate(next);
  if (current) current.retireAt = now;
  ring.keys.push({ kid: publicJwk.kid, privateJwk: next, publicJwk, createdAt: now, retireAt: null });
  ring.currentKid = publicJwk.kid;
  ring.keys = ring.keys.filter((key) => key.retireAt == null || key.retireAt + KEY_VERIFY_WINDOW_MS > now);
  isolateRing = ring;
  isolateCtx = null;
  try {
    await env.KEYS.put(RING_KEY, JSON.stringify(ring));
  } catch {
    // best-effort
  }
  return { kid: publicJwk.kid, rotated: true };
}

export async function verificationKeys(env: Env): Promise<PublicJwk[]> {
  return (await jwksDocument(env)).keys;
}

export function resetRingForTests(): void {
  isolateCtx = null;
  isolateRing = null;
}
