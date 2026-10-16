import { bytes, fromBase64Url, toBase64Url } from "./encoding";

export type JwtHeader = { alg: "ES256"; typ: "JWT"; kid: string };
export type JwtClaims = {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  token_use?: "access" | "id";
  scope?: string;
};

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
    if (header.alg !== "ES256" || typeof claims.sub !== "string") return null;
    return { header, claims };
  } catch {
    return null;
  }
}

export async function verifyJwt(token: string, key: CryptoKey, now = Math.floor(Date.now() / 1000)): Promise<JwtClaims | null> {
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
  if (decoded.claims.exp <= now || (decoded.claims.nbf ?? 0) > now) return null;
  return decoded.claims;
}
