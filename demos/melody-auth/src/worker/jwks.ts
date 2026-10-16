import { KEY_ROTATE_MS, KEY_VERIFY_WINDOW_MS } from "../shared/types";
import { fromBase64Url, randomId, toBase64Url } from "./encoding";
import { HttpError } from "./errors";
import { envSecret } from "./clients";
import {
  generateEs256,
  importSigningKey,
  parsePrivateJwk,
  publicJwkFromPrivate,
  type EcPrivateJwk,
  type PublicJwk,
} from "./jwt";
import { isLocalEnv } from "./origin";
import { JWKS_CACHE_MS, RING_REFRESH_MS } from "./policy";

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
  wrappedD: string;
  createdAt: number;
  retireAt: number | null;
};

type Ring = {
  currentKid: string;
  nextKid: string | null;
  keys: KeyRecord[];
  loadedAt: number;
};

type StoredKey = {
  kid: string;
  publicJwk: PublicJwk;
  wrappedD?: string;
  privateJwk?: EcPrivateJwk;
  createdAt: number;
  retireAt: number | null;
};

type StoredRing = {
  currentKid: string;
  nextKid?: string | null;
  keys: StoredKey[];
};

let isolateCtx: SigningContext | null = null;
let isolateRing: Ring | null = null;

export function isCommittedDemoKey(jwk: { kid?: string; d?: string }): boolean {
  return jwk.kid === DEMO_KID || jwk.d === DEMO_D;
}

export function rejectDemoSigningKey(jwk: { kid?: string; d?: string }, env: { ENVIRONMENT?: string }): boolean {
  return isCommittedDemoKey(jwk) && !isLocalEnv(env);
}

function decodeKek(raw: string): Uint8Array | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  try {
    const decoded = fromBase64Url(trimmed);
    return decoded.byteLength === 32 ? decoded : null;
  } catch {
    return null;
  }
}

async function importKek(env: Env): Promise<CryptoKey | null> {
  const material = decodeKek(envSecret(env, "AUTH_KEK"));
  if (!material) return null;
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function wrapD(d: string, kek: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, new TextEncoder().encode(d)));
  const packed = new Uint8Array(iv.byteLength + ct.byteLength);
  packed.set(iv, 0);
  packed.set(ct, iv.byteLength);
  return toBase64Url(packed);
}

async function unwrapD(wrapped: string, kek: CryptoKey): Promise<string> {
  const packed = fromBase64Url(wrapped);
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, kek, ct);
  return new TextDecoder().decode(plain);
}

async function ensureWrapped(ring: Ring, kek: CryptoKey): Promise<void> {
  for (const key of ring.keys) {
    if (!key.wrappedD) key.wrappedD = await wrapD(key.privateJwk.d, kek);
  }
}

function storedFrom(ring: Ring): StoredRing {
  return {
    currentKid: ring.currentKid,
    nextKid: ring.nextKid,
    keys: ring.keys.map((key) => ({
      kid: key.kid,
      publicJwk: key.publicJwk,
      wrappedD: key.wrappedD,
      createdAt: key.createdAt,
      retireAt: key.retireAt,
    })),
  };
}

async function persistRing(env: Env, ring: Ring, kek: CryptoKey): Promise<void> {
  await ensureWrapped(ring, kek);
  await env.KEYS.put(RING_KEY, JSON.stringify(storedFrom(ring)));
}

function isStoredRing(value: unknown): value is StoredRing {
  if (!value || typeof value !== "object") return false;
  const ring = value as StoredRing;
  return typeof ring.currentKid === "string" && Array.isArray(ring.keys) && ring.keys.length > 0;
}

async function memoryFromSecret(env: Env, now: number): Promise<Ring> {
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
    nextKid: null,
    loadedAt: now,
    keys: [{ kid: publicJwk.kid, privateJwk, publicJwk, wrappedD: "", createdAt: now, retireAt: null }],
  };
}

async function ringFromStored(stored: StoredRing, kek: CryptoKey | null, now: number): Promise<Ring | null> {
  const keys: KeyRecord[] = [];
  for (const item of stored.keys) {
    const publicJwk = item.publicJwk;
    if (!publicJwk?.x || !publicJwk.y || !item.kid) continue;
    let privateJwk: EcPrivateJwk | null = null;
    let wrappedD = item.wrappedD ?? "";
    if (wrappedD && kek) {
      try {
        const d = await unwrapD(wrappedD, kek);
        privateJwk = { ...publicJwk, d };
      } catch {
        privateJwk = null;
      }
    } else if (item.privateJwk?.d) {
      privateJwk = item.privateJwk;
      wrappedD = "";
    }
    if (!privateJwk) continue;
    keys.push({
      kid: item.kid,
      privateJwk,
      publicJwk,
      wrappedD,
      createdAt: item.createdAt,
      retireAt: item.retireAt,
    });
  }
  if (!keys.some((key) => key.kid === stored.currentKid)) return null;
  return { currentKid: stored.currentKid, nextKid: stored.nextKid ?? null, keys, loadedAt: now };
}

async function loadRing(env: Env, now: number): Promise<Ring> {
  if (isolateRing && now - isolateRing.loadedAt < RING_REFRESH_MS) return isolateRing;
  const kek = await importKek(env);
  let stored: unknown;
  try {
    stored = await env.KEYS.get(RING_KEY, "json");
  } catch {
    if (isolateRing) return isolateRing;
    const ring = await memoryFromSecret(env, now);
    isolateRing = ring;
    return ring;
  }
  if (isStoredRing(stored)) {
    const parsed = await ringFromStored(stored, kek, now);
    if (parsed) {
      isolateRing = parsed;
      return parsed;
    }
    if (isolateRing) return isolateRing;
  }
  const ring = await memoryFromSecret(env, now);
  if (kek && !isStoredRing(stored)) {
    try {
      await persistRing(env, ring, kek);
    } catch {
      // a failed first write must not block signing from the secret
    }
  }
  isolateRing = ring;
  return ring;
}

export async function signingContext(env: Env): Promise<SigningContext> {
  const now = Date.now();
  const ring = await loadRing(env, now);
  const current = ring.keys.find((key) => key.kid === ring.currentKid);
  if (!current) throw new HttpError(503, "misconfigured", "The server failed. Try again.");
  if (rejectDemoSigningKey(current.privateJwk, env)) {
    throw new HttpError(503, "misconfigured", "The server failed. Try again.");
  }
  if (isolateCtx && isolateCtx.kid === current.kid && isolateCtx.privateJwk.d === current.privateJwk.d) return isolateCtx;
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
  const kek = await importKek(env);
  const ring = await loadRing(env, now);
  const current = ring.keys.find((key) => key.kid === ring.currentKid);
  if (!kek || !current) return { kid: ring.currentKid, rotated: false };
  if (rejectDemoSigningKey(current.privateJwk, env)) return { kid: current.kid, rotated: false };

  const staged = ring.nextKid ? ring.keys.find((key) => key.kid === ring.nextKid) : undefined;
  if (staged && now - staged.createdAt >= JWKS_CACHE_MS) {
    current.retireAt = now;
    ring.currentKid = staged.kid;
    ring.nextKid = null;
    ring.keys = ring.keys.filter((key) => key.retireAt == null || key.retireAt + KEY_VERIFY_WINDOW_MS > now);
    ring.loadedAt = now;
    isolateRing = ring;
    isolateCtx = null;
    try {
      await persistRing(env, ring, kek);
    } catch {
      // signing already switched in this isolate; the next refresh reconciles
    }
    return { kid: staged.kid, rotated: true };
  }
  if (staged) return { kid: ring.currentKid, rotated: false };
  if (now - current.createdAt < KEY_ROTATE_MS) return { kid: current.kid, rotated: false };

  const next = await generateEs256(randomId("kid").replace("kid_", "melody-"));
  const publicJwk = publicJwkFromPrivate(next);
  ring.keys.push({
    kid: publicJwk.kid,
    privateJwk: next,
    publicJwk,
    wrappedD: await wrapD(next.d, kek),
    createdAt: now,
    retireAt: null,
  });
  ring.nextKid = publicJwk.kid;
  ring.loadedAt = now;
  isolateRing = ring;
  try {
    await persistRing(env, ring, kek);
  } catch {
    ring.nextKid = null;
    ring.keys = ring.keys.filter((key) => key.kid !== publicJwk.kid);
  }
  return { kid: ring.currentKid, rotated: false };
}

export async function verificationKeys(env: Env): Promise<PublicJwk[]> {
  return (await jwksDocument(env)).keys;
}

export function resetRingForTests(): void {
  isolateCtx = null;
  isolateRing = null;
}

export function expireRingCacheForTests(): void {
  if (isolateRing) isolateRing.loadedAt = 0;
}
