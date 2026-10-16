import { bytes, fromBase64Url, toBase64Url } from "./encoding";

export type JwtHeader = { alg: "ES256"; typ: "JWT" | "at+jwt"; kid: string };
export type JwtClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  iat: number;
  exp: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  token_use?: "access" | "id";
  scope?: string;
  client_id?: string;
  jti?: string;
  azp?: string;
  auth_time?: number;
  act?: ActClaim;
};

export type ActClaim = { sub: string; act?: ActClaim };

export type VerifyOptions = { ignoreExp?: boolean };

export type PublicJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
};

export type EcPrivateJwk = PublicJwk & { d: string };

export function parsePrivateJwk(raw: string): EcPrivateJwk {
  const parsed = JSON.parse(raw) as Partial<EcPrivateJwk>;
  if (parsed.kty !== "EC" || parsed.crv !== "P-256" || !parsed.d || !parsed.x || !parsed.y) {
    throw new Error("jwk");
  }
  return {
    kty: "EC",
    crv: "P-256",
    d: parsed.d,
    x: parsed.x,
    y: parsed.y,
    kid: parsed.kid || "melody-1",
    alg: "ES256",
    use: "sig",
  };
}

export function publicJwkFromPrivate(jwk: EcPrivateJwk): PublicJwk {
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    kid: jwk.kid || "melody-1",
    alg: "ES256",
    use: "sig",
  };
}

export async function importSigningKey(jwk: EcPrivateJwk): Promise<CryptoKey> {
  const material: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: jwk.d,
    x: jwk.x,
    y: jwk.y,
    ext: true,
  };
  return crypto.subtle.importKey("jwk", material, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function importVerifyKey(jwk: PublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

function encodePart(value: unknown): string {
  return toBase64Url(bytes(JSON.stringify(value)));
}

export async function signJwt(header: JwtHeader, claims: JwtClaims, key: CryptoKey): Promise<string> {
  const signingInput = `${encodePart(header)}.${encodePart(claims)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes(signingInput)),
  );
  return `${signingInput}.${toBase64Url(signature)}`;
}

export function decodeJwt(token: string): { header: JwtHeader; claims: JwtClaims } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as JwtHeader;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as JwtClaims;
    if (header.alg !== "ES256" || (header.typ !== "JWT" && header.typ !== "at+jwt") || typeof claims.sub !== "string") return null;
    return { header, claims };
  } catch {
    return null;
  }
}

export async function verifyJwt(
  token: string,
  key: CryptoKey,
  now = Math.floor(Date.now() / 1000),
  options?: VerifyOptions,
): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const decoded = decodeJwt(token);
  if (!decoded) return null;
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64Url(parts[2]),
    bytes(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  if (typeof decoded.claims.exp !== "number" || !Number.isFinite(decoded.claims.exp)) return null;
  if (!options?.ignoreExp && (decoded.claims.exp <= now || (decoded.claims.nbf ?? 0) > now)) return null;
  return decoded.claims;
}

export async function generateEs256(kid: string): Promise<EcPrivateJwk> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("jwk");
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (!priv.d || !priv.x || !priv.y) throw new Error("jwk");
  return {
    kty: "EC",
    crv: "P-256",
    d: priv.d,
    x: priv.x,
    y: priv.y,
    kid,
    alg: "ES256",
    use: "sig",
  };
}

export async function verifyJwtWithKeys(
  token: string,
  keys: PublicJwk[],
  now = Math.floor(Date.now() / 1000),
  options?: VerifyOptions,
): Promise<JwtClaims | null> {
  const decoded = decodeJwt(token);
  if (!decoded) return null;
  const match = keys.filter((key) => !decoded.header.kid || key.kid === decoded.header.kid);
  const list = match.length ? match : keys;
  for (const jwk of list) {
    try {
      const claims = await verifyJwt(token, await importVerifyKey(jwk), now, options);
      if (claims) return claims;
    } catch {
      // a bad client JWK must not become a 500
    }
  }
  return null;
}
