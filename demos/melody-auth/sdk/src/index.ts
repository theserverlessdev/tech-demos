/** Zero-dep Melody Auth client for Workers, browsers, and Node. */

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

function b64url(data: Uint8Array): string {
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  const encoded = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function discover(issuer: string): Promise<Discovered> {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("discovery");
  return (await res.json()) as Discovered;
}

export async function createPkce(): Promise<PkcePair> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(bytes);
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
  if (!res.ok) throw new Error("token");
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
  if (!res.ok) throw new Error("refresh");
  return (await res.json()) as TokenSet;
}

type Jwk = { kty: string; crv?: string; x?: string; y?: string; kid?: string; alg?: string };
const jwksCache = new Map<string, { exp: number; keys: Jwk[] }>();

export async function jwksKeys(jwksUri: string, now = Date.now()): Promise<Jwk[]> {
  const hit = jwksCache.get(jwksUri);
  if (hit && hit.exp > now) return hit.keys;
  const res = await fetch(jwksUri);
  const doc = (await res.json()) as { keys?: Jwk[] };
  const keys = doc.keys ?? [];
  jwksCache.set(jwksUri, { exp: now + 300_000, keys });
  return keys;
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
  expected: { issuer: string; audience?: string | string[] },
  now = Math.floor(Date.now() / 1000),
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("jwt");
  const header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))) as { alg?: string; kid?: string; typ?: string };
  if (header.alg !== "ES256") throw new Error("alg");
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as Record<string, unknown>;
  if (claims.iss !== expected.issuer) throw new Error("iss");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("exp");
  if (expected.audience) {
    const want = Array.isArray(expected.audience) ? expected.audience : [expected.audience];
    const aud = claims.aud;
    const have = Array.isArray(aud) ? aud : [aud];
    if (!want.some((item) => have.includes(item))) throw new Error("aud");
  }
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
  input: { issuer: string; jwksUri: string; audience?: string | string[] },
): Promise<Record<string, unknown>> {
  return verifyJwt(token, await jwksKeys(input.jwksUri), { issuer: input.issuer, audience: input.audience });
}

/** Workers fetch handler: returns claims or a 401 Response. */
export function protect(input: { issuer: string; jwksUri?: string; audience?: string | string[] }) {
  const jwksUri = input.jwksUri ?? `${input.issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  return async (request: Request): Promise<Record<string, unknown>> => {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) throw new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    try {
      return await verifyAccessToken(match[1], { issuer: input.issuer, jwksUri, audience: input.audience });
    } catch {
      throw new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
  };
}

/** Hono-shaped middleware: (c, next) => Promise<void>. Sets c.get?. if present, else c.jwt. */
export function bearerAuth(input: { issuer: string; jwksUri?: string; audience?: string | string[] }) {
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
