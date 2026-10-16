import { HttpError } from "./errors";
import { importSigningKey, parsePrivateJwk, publicJwkFromPrivate, type EcPrivateJwk, type PublicJwk } from "./jwt";
import { isLocalEnv } from "./origin";

const KV_KEY = "jwks:current";
export const DEMO_KID = "melody-demo-1";
export const DEMO_D = "p2rJ5XiDRi5pLLG9gzH4qoXbs2GKJ5KN3jruLjfILW0";

export type SigningContext = {
  kid: string;
  privateJwk: EcPrivateJwk;
  publicJwk: PublicJwk;
  key: CryptoKey;
};

let isolateCtx: SigningContext | null = null;

export function isCommittedDemoKey(jwk: { kid?: string; d?: string }): boolean {
  return jwk.kid === DEMO_KID || jwk.d === DEMO_D;
}

export function rejectDemoSigningKey(jwk: { kid?: string; d?: string }, env: { ENVIRONMENT?: string }): boolean {
  return isCommittedDemoKey(jwk) && !isLocalEnv(env);
}

export async function signingContext(env: Env): Promise<SigningContext> {
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
  if (isolateCtx && isolateCtx.privateJwk.d === privateJwk.d && isolateCtx.kid === privateJwk.kid) {
    return isolateCtx;
  }
  const publicJwk = publicJwkFromPrivate(privateJwk);
  const kid = publicJwk.kid;
  try {
    const cached = await env.KEYS.get(KV_KEY, "json");
    if (!cached || JSON.stringify(cached) !== JSON.stringify(publicJwk)) {
      await env.KEYS.put(KV_KEY, JSON.stringify(publicJwk));
    }
  } catch {
    // KV is best-effort metadata. The secret is the source of truth.
  }
  isolateCtx = { kid, privateJwk, publicJwk, key: await importSigningKey(privateJwk) };
  return isolateCtx;
}

export async function jwksDocument(env: Env): Promise<{ keys: PublicJwk[] }> {
  const ctx = await signingContext(env);
  return { keys: [ctx.publicJwk] };
}
