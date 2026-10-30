import { isCatalog, isRole, type Role } from "./policy";
import type { CatalogId } from "./rows";

export const ISSUER = "lake-catalog";
export const AUDIENCE = "lake-catalog:quack";
export const DEV_JWT_SECRET = "dev-lake-catalog-jwt-secret";
export const DEV_CONNECTION_SECRET = "dev-lake-catalog-connection-secret";

export type Claims = {
  role: Role;
  catalog: CatalogId;
  iat: number;
  exp: number;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export async function signJwt(secret: string, claims: Claims): Promise<string> {
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ ...claims, iss: ISSUER, aud: AUDIENCE })),
  );
  const signature = bytesToBase64Url(await hmac(secret, `${header}.${payload}`));
  return `${header}.${payload}.${signature}`;
}

export async function verifyJwt(secret: string, token: string, nowSeconds: number): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;
  const expected = await hmac(secret, `${header}.${payload}`);
  let got: Uint8Array;
  try {
    got = base64UrlToBytes(signature);
  } catch {
    return null;
  }
  if (!sameBytes(expected, got)) return null;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.iss !== ISSUER || record.aud !== AUDIENCE) return null;
  if (typeof record.role !== "string" || !isRole(record.role)) return null;
  if (typeof record.catalog !== "string" || !isCatalog(record.catalog)) return null;
  if (typeof record.exp !== "number" || typeof record.iat !== "number") return null;
  if (record.exp <= nowSeconds || record.iat > nowSeconds + 60) return null;
  return { role: record.role, catalog: record.catalog, iat: record.iat, exp: record.exp };
}

export type ConnectionPayload = { catalog: CatalogId; role: Role; exp: number; sid: string };

export async function signConnection(secret: string, payload: ConnectionPayload): Promise<string> {
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = bytesToBase64Url(await hmac(secret, body));
  return `${body}.${mac}`;
}

export async function verifyConnection(secret: string, token: string, nowSeconds: number): Promise<ConnectionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  if (!body || !mac) return null;
  let got: Uint8Array;
  try {
    got = base64UrlToBytes(mac);
  } catch {
    return null;
  }
  if (!sameBytes(await hmac(secret, body), got)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.catalog !== "string" || !isCatalog(record.catalog)) return null;
  if (typeof record.role !== "string" || !isRole(record.role)) return null;
  if (typeof record.exp !== "number" || record.exp <= nowSeconds) return null;
  if (typeof record.sid !== "string" || record.sid.length < 8) return null;
  return { catalog: record.catalog, role: record.role, exp: record.exp, sid: record.sid };
}

export function duckdbSnippet(opts: { token: string; host: string; port?: string; secure: boolean }): string {
  const port = opts.port ?? (opts.secure ? "443" : "80");
  const uri = `quack:${opts.host}:${port}`;
  const bucket = "tech-demos-lake-catalog";
  return [
    "-- Read-only demo token. It expires ten minutes after it was minted.",
    "-- The Worker checks the role before any SQL runs. This is not a full DuckDB server.",
    `-- Parquet for this catalog: r2://${bucket}/catalogs/orders/orders.parquet`,
    "FORCE INSTALL quack FROM core_nightly;",
    "LOAD quack;",
    "CREATE OR REPLACE SECRET lake_catalog (",
    "  TYPE quack,",
    `  TOKEN '${opts.token}',`,
    `  SCOPE '${uri}'`,
    ");",
    `ATTACH '${uri}' AS lake (READ_ONLY);`,
    "SELECT region, product, units FROM lake.orders;",
  ].join("\n");
}
