import { HttpError } from "./errors";
import { importSigningKey, parsePrivateJwk, publicJwkFromPrivate, type EcPrivateJwk, type PublicJwk } from "./jwt";
import { isLocalEnv } from "./origin";

const KV_KEY = "jwks:current";
const DEMO_KID = "melody-demo-1";
const DEMO_D = "p2rJ5XiDRi5pLLG9gzH4qoXbs2GKJ5KN3jruLjfILW0";

export type SigningContext = {
  kid: string;
  privateJwk: EcPrivateJwk;
  publicJwk: PublicJwk;
  key: CryptoKey;
};

let isolateCtx: SigningContext | null = null;

function isCommittedDemoKey(jwk: EcPrivateJwk): boolean {
  return jwk.kid === DEMO_KID || jwk.d === DEMO_D;
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
  if (isCommittedDemoKey(privateJwk) && !isLocalEnv(env)) {
    throw new HttpError(503, "misconfigured", "The server failed. Try again.");
  }
  if (isolateCtx && isolateCtx.privateJwk.d === privateJwk.d && isolateCtx.kid === privateJwk.kid) {
    return isolateCtx;
  }
  const publicJwk = publicJwkFromPrivate(privateJwk);
  const kid = publicJwk.kid;
  const cached = await env.KEYS.get(KV_KEY, "json");
  if (!cached || JSON.stringify(cached) !== JSON.stringify(publicJwk)) {
    await env.KEYS.put(KV_KEY, JSON.stringify(publicJwk));
  }
  isolateCtx = { kid, privateJwk, publicJwk, key: await importSigningKey(privateJwk) };
  return isolateCtx;
}

export async function jwksDocument(env: Env): Promise<{ keys: PublicJwk[] }> {
  const cached = (await env.KEYS.get(KV_KEY, "json")) as PublicJwk | null;
  if (cached?.kty === "EC" && cached.crv === "P-256" && cached.x && cached.y && cached.kid) {
    return { keys: [cached] };
  }
  const ctx = await signingContext(env);
  return { keys: [ctx.publicJwk] };
}
