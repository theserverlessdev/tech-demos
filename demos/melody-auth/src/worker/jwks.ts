import { HttpError } from "./errors";
import { importSigningKey, parsePrivateJwk, publicJwkFromPrivate, type EcPrivateJwk, type PublicJwk } from "./jwt";

const KV_KEY = "jwks:current";

export type SigningContext = {
  kid: string;
  privateJwk: EcPrivateJwk;
  publicJwk: PublicJwk;
  key: CryptoKey;
};

export async function signingContext(env: Env): Promise<SigningContext> {
  const raw = env.AUTH_PRIVATE_JWK?.trim() ?? "";
  if (!raw) throw new HttpError(503, "misconfigured", "The server failed. Try again.");
  let privateJwk: EcPrivateJwk;
  try {
    privateJwk = parsePrivateJwk(raw);
  } catch {
    throw new HttpError(503, "misconfigured", "The server failed. Try again.");
  }
  const publicJwk = publicJwkFromPrivate(privateJwk);
  const kid = publicJwk.kid;
  const cached = await env.KEYS.get(KV_KEY, "json");
  if (!cached || JSON.stringify(cached) !== JSON.stringify(publicJwk)) {
    await env.KEYS.put(KV_KEY, JSON.stringify(publicJwk));
  }
  return { kid, privateJwk, publicJwk, key: await importSigningKey(privateJwk) };
}

export async function jwksDocument(env: Env): Promise<{ keys: PublicJwk[] }> {
  const ctx = await signingContext(env);
  return { keys: [ctx.publicJwk] };
}
