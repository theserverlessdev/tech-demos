/** Zero-dep Melody Auth client for Workers, browsers, and Node.
 *  "Token exchange" here means the authorization-code grant. RFC 8693 token exchange is not implemented in this SDK.
 */

export type Discovered = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  end_session_endpoint?: string;
};

export type PkcePair = { verifier: string; challenge: string; method: "S256" };

export type TokenSet = {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
};

export class OauthClientError extends Error {
  constructor(
    public code: string,
    public description: string,
    public status: number,
  ) {
    super(description || code);
    this.name = "OauthClientError";
  }
}

const SKEW_SEC = 60;

function b64url(data: Uint8Array): string {
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(size = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(size)));
}

export async function discover(issuer: string): Promise<Discovered> {
  const expected = issuer.replace(/\/$/, "");
  const res = await fetch(`${expected}/.well-known/openid-configuration`);
  if (!res.ok) throw new OauthClientError("discovery", "Discovery failed.", res.status);
  const doc = (await res.json()) as Discovered;
  if (doc.issuer.replace(/\/$/, "") !== expected) throw new OauthClientError("issuer", "Discovery issuer did not match.", 400);
  return doc;
}

export async function createPkce(): Promise<PkcePair> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)), method: "S256" };
}

export function authorizationUrl(
  discovered: Discovered,
  input: {
    clientId: string;
    redirectUri: string;
    scope?: string;
    state: string;
    nonce: string;
    challenge: string;
  },
): string {
  const url = new URL(discovered.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope ?? "openid profile email offline_access");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function readTokenError(res: Response, fallback: string): Promise<OauthClientError> {
  const body = (await res.json().catch(() => null)) as { error?: string; error_description?: string } | null;
  return new OauthClientError(body?.error || fallback, body?.error_description || fallback, res.status);
}

export async function exchangeCode(
  discovered: Discovered,
  input: { clientId: string; redirectUri: string; code: string; verifier: string; clientSecret?: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  const res = await fetch(discovered.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw await readTokenError(res, "token");
  return (await res.json()) as TokenSet;
}

export async function refresh(
  discovered: Discovered,
  input: { clientId: string; refreshToken: string; clientSecret?: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  const res = await fetch(discovered.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw await readTokenError(res, "refresh");
  return (await res.json()) as TokenSet;
}

type Jwk = { kty: string; crv?: string; x?: string; y?: string; kid?: string; alg?: string };
const jwksCache = new Map<string, { exp: number; keys: Jwk[] }>();
let lastForceAt = 0;

export async function jwksKeys(jwksUri: string, now = Date.now(), force = false): Promise<Jwk[]> {
  if (force && now - lastForceAt < 30_000) {
    const hit = jwksCache.get(jwksUri);
    if (hit?.keys.length) return hit.keys;
    throw new Error("jwks");
  }
  if (!force) {
    const hit = jwksCache.get(jwksUri);
    if (hit && hit.exp > now && hit.keys.length) return hit.keys;
  }
  const res = await fetch(jwksUri);
  if (!res.ok) throw new Error("jwks");
  const doc = (await res.json()) as { keys?: Jwk[] };
  const keys = doc.keys ?? [];
  if (!keys.length) throw new Error("jwks");
  if (force) lastForceAt = now;
  jwksCache.set(jwksUri, { exp: now + 300_000, keys });
  return keys;
}

export function resetJwksCacheForTests(): void {
  jwksCache.clear();
  lastForceAt = 0;
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyJwt(
  token: string,
  keys: Jwk[],
  expected: { issuer: string; audience?: string | string[]; nonce?: string; access?: boolean; id?: boolean; azp?: string },
  now = Math.floor(Date.now() / 1000),
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("jwt");
  const header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))) as { alg?: string; kid?: string; typ?: string };
  if (header.alg !== "ES256") throw new Error("alg");
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as Record<string, unknown>;
  if (expected.access && (header.typ !== "at+jwt" || claims.token_use !== "access")) throw new Error("typ");
  if (expected.id && (header.typ === "at+jwt" || claims.token_use === "access")) throw new Error("typ");
  if (claims.iss !== expected.issuer) throw new Error("iss");
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SEC <= now) throw new Error("exp");
  if (typeof claims.nbf === "number" && claims.nbf > now + SKEW_SEC) throw new Error("nbf");
  if (typeof claims.iat === "number" && claims.iat > now + SKEW_SEC) throw new Error("iat");
  if (expected.audience) {
    const want = Array.isArray(expected.audience) ? expected.audience : [expected.audience];
    const aud = claims.aud;
    const have = Array.isArray(aud) ? aud : [aud];
    if (!want.some((item) => have.includes(item))) throw new Error("aud");
  }
  if (expected.nonce && claims.nonce !== expected.nonce) throw new Error("nonce");
  if (expected.azp && claims.azp !== expected.azp) throw new Error("azp");
  if (header.kid && !keys.some((key) => key.kid === header.kid)) throw new Error("kid");
  const candidates = keys.filter((key) => !header.kid || key.kid === header.kid);
  const list = candidates.length ? candidates : keys;
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = fromB64url(parts[2]);
  for (const jwk of list) {
    if (!jwk.x || !jwk.y) continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signingInput);
    if (ok) return claims;
  }
  throw new Error("sig");
}

export async function verifyAccessToken(
  token: string,
  input: { issuer: string; jwksUri: string; audience: string | string[] },
): Promise<Record<string, unknown>> {
  if (!input.audience || (Array.isArray(input.audience) && input.audience.length === 0)) throw new Error("aud_required");
  const keys = await jwksKeys(input.jwksUri);
  try {
    return await verifyJwt(token, keys, { issuer: input.issuer, audience: input.audience, access: true });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "kid") throw err;
    const fresh = await jwksKeys(input.jwksUri, Date.now(), true);
    return verifyJwt(token, fresh, { issuer: input.issuer, audience: input.audience, access: true });
  }
}

export async function verifyIdToken(
  token: string,
  input: { issuer: string; jwksUri: string; audience: string | string[]; nonce?: string; azp?: string },
): Promise<Record<string, unknown>> {
  const keys = await jwksKeys(input.jwksUri);
  return verifyJwt(token, keys, { issuer: input.issuer, audience: input.audience, nonce: input.nonce, azp: input.azp, id: true });
}

/** Authorization-code callback: checks state, exchanges the code, and checks the ID token nonce. */
export async function completeAuthorizationCode(input: {
  discovered: Discovered;
  callbackUrl: string;
  clientId: string;
  redirectUri: string;
  expectedState: string;
  expectedNonce: string;
  verifier: string;
  clientSecret?: string;
  jwksUri?: string;
}): Promise<TokenSet> {
  const params = new URL(input.callbackUrl).searchParams;
  const error = params.get("error");
  if (error) throw new OauthClientError(error, params.get("error_description") ?? error, 400);
  if (params.get("state") !== input.expectedState) throw new OauthClientError("state", "State did not match.", 400);
  const code = params.get("code") ?? "";
  if (!code) throw new OauthClientError("invalid_request", "Missing code.", 400);
  const tokens = await exchangeCode(input.discovered, {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    code,
    verifier: input.verifier,
    clientSecret: input.clientSecret,
  });
  if (tokens.id_token) {
    await verifyIdToken(tokens.id_token, {
      issuer: input.discovered.issuer,
      jwksUri: input.jwksUri ?? input.discovered.jwks_uri,
      audience: input.clientId,
      nonce: input.expectedNonce,
      azp: input.clientId,
    });
  }
  return tokens;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' },
  });
}

/** Workers fetch handler: returns claims or a 401 Response. */
export function protect(input: { issuer: string; jwksUri?: string; audience: string | string[] }) {
  const jwksUri = input.jwksUri ?? `${input.issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  return async (request: Request): Promise<Record<string, unknown>> => {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) throw unauthorized();
    try {
      return await verifyAccessToken(match[1], { issuer: input.issuer, jwksUri, audience: input.audience });
    } catch {
      throw unauthorized();
    }
  };
}

/** Hono-shaped middleware: (c, next) => Promise<void>. Sets c.get?. if present, else c.jwt. */
export function bearerAuth(input: { issuer: string; jwksUri?: string; audience: string | string[] }) {
  const check = protect(input);
  return async (
    c: { req: { raw?: Request; header: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response; set?: (k: string, v: unknown) => void } & { jwt?: unknown },
    next: () => Promise<void>,
  ): Promise<Response | void> => {
    const raw =
      c.req.raw ??
      new Request("https://local.invalid", { headers: { authorization: c.req.header("authorization") ?? "" } });
    try {
      const claims = await check(raw);
      if (c.set) c.set("jwt", claims);
      c.jwt = claims;
      await next();
    } catch (err) {
      if (err instanceof Response) return err;
      return c.json({ error: "unauthorized" }, 401);
    }
  };
}
