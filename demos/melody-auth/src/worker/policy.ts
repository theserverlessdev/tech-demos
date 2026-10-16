import { STANDARD_SCOPES } from "../shared/types";

export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const PRIVILEGED_GRANTS = new Set(["client_credentials", TOKEN_EXCHANGE]);
export const DCR_GRANTS = new Set([
  "authorization_code",
  "refresh_token",
  "client_credentials",
  DEVICE_GRANT,
  TOKEN_EXCHANGE,
]);
export const JWKS_CACHE_MS = 300_000;
export const RING_REFRESH_MS = 60_000;
export const ASSERTION_MAX_TTL_SEC = 300;
export const DCR_CLIENT_CAP = 500;
export const CLOCK_SKEW_SEC = 60;

const STANDARD = new Set<string>(STANDARD_SCOPES);

export function tokenExchangeAllowed(grants: string[], clientType: string): boolean {
  return clientType === "confidential" && grants.includes(TOKEN_EXCHANGE);
}

/** Reject unless the client is confidential AND explicitly allowed to exchange tokens. */
export function tokenExchangeDenied(allowsGrant: boolean, clientType: string): boolean {
  return !allowsGrant || clientType !== "confidential";
}

export function scopeSubset(requested: string | undefined, allowed: string | undefined): string | null {
  const have = new Set((allowed ?? "").split(/\s+/).filter(Boolean));
  const raw = requested && requested.trim() ? requested : (allowed ?? "");
  const ask = raw.split(/\s+/).filter(Boolean);
  if (!ask.length || ask.some((scope) => !have.has(scope))) return null;
  return ask.join(" ");
}

export function audienceAllowList(resourcesJson: string | null | undefined, clientId: string): string[] {
  const extra = parseList(resourcesJson);
  return [...new Set([clientId, ...extra])];
}

export function audienceAllowed(audience: string, resourcesJson: string | null | undefined, clientId: string): boolean {
  if (!audience) return false;
  return audienceAllowList(resourcesJson, clientId).includes(audience);
}

export function deviceCodeForeign(rowClientId: string | undefined, callerId: string): boolean {
  return Boolean(rowClientId) && rowClientId !== callerId;
}

export function subjectBoundToClient(claims: { aud?: string | string[]; client_id?: string }, clientId: string): boolean {
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  return aud.includes(clientId) || claims.client_id === clientId;
}

export function exchangeExp(nowSec: number, subjectExp: number, ttlSec: number): number | null {
  if (!Number.isFinite(subjectExp)) return null;
  const exp = Math.min(nowSec + ttlSec, subjectExp);
  return exp > nowSec ? exp : null;
}

export function actClaim(clientId: string, prior: { sub: string } | undefined): { sub: string; act?: { sub: string } } {
  return prior ? { sub: clientId, act: prior } : { sub: clientId };
}

export function filterDcrGrants(grants: string[], admin: boolean): string[] {
  return grants.filter((grant) => DCR_GRANTS.has(grant) && (admin || !PRIVILEGED_GRANTS.has(grant)));
}

export function standardScope(scope: string | undefined): string {
  const kept = (scope ?? "openid profile email offline_access")
    .split(/\s+/)
    .filter((part) => STANDARD.has(part));
  return [...new Set(kept)].join(" ");
}

const BANNED_SCHEME = new Set(["javascript:", "data:", "file:", "blob:", "about:", "vbscript:", "ws:", "wss:"]);

export function redirectUriShape(uri: string): boolean {
  if (!uri || uri.length > 512 || uri.includes("#") || uri.includes(" ")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    const host = url.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  }
  if (BANNED_SCHEME.has(url.protocol)) return false;
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

export function validateRedirectList(uris: string[]): { ok: true; uris: string[] } | { ok: false; error: string } {
  if (uris.length > 5) return { ok: false, error: "At most 5 redirect URIs." };
  for (const uri of uris) {
    if (!redirectUriShape(uri)) return { ok: false, error: "A redirect URI is not allowed." };
  }
  return { ok: true, uris };
}

export function normalizeClientJwks(value: unknown): { ok: true; jwks: string | null } | { ok: false; error: string } {
  if (value == null || value === "") return { ok: true, jwks: null };
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return { ok: false, error: "jwks must be a JSON object." };
    }
  }
  const keys = (parsed as { keys?: unknown }).keys;
  if (!keys) return { ok: true, jwks: null };
  if (!Array.isArray(keys) || keys.length > 5) return { ok: false, error: "jwks allows at most 5 EC P-256 keys." };
  const clean = [];
  for (const key of keys) {
    const row = key as { kty?: string; crv?: string; x?: string; y?: string; kid?: string };
    if (row.kty !== "EC" || row.crv !== "P-256" || !row.x || !row.y) return { ok: false, error: "jwks keys must be EC P-256 with x and y." };
    clean.push({ kty: "EC", crv: "P-256", x: row.x, y: row.y, kid: row.kid || "client", alg: "ES256", use: "sig" });
  }
  return { ok: true, jwks: JSON.stringify({ keys: clean }) };
}

export function pkceDisposition(challenge: string, verifier: string): "verify" | "reject" | "skip" {
  if (challenge) return "verify";
  if (verifier) return "reject";
  return "skip";
}

export function assertionLifetimeOk(claims: { exp?: number; iat?: number; jti?: string }, nowSec: number): boolean {
  if (!claims.jti || typeof claims.exp !== "number" || typeof claims.iat !== "number") return false;
  if (claims.exp <= nowSec || claims.iat > nowSec + CLOCK_SKEW_SEC) return false;
  return claims.exp - nowSec <= ASSERTION_MAX_TTL_SEC;
}

export function isAccessJwt(headerTyp: string | undefined, tokenUse: string | undefined): boolean {
  return headerTyp === "at+jwt" && tokenUse === "access";
}

export function tokenVisibleToClient(
  tokenClientId: string | undefined,
  aud: string | string[] | undefined,
  callerId: string,
  resourcesJson: string | null | undefined,
): boolean {
  if (tokenClientId === callerId) return true;
  const audiences = Array.isArray(aud) ? aud : aud ? [aud] : [];
  const allow = new Set(audienceAllowList(resourcesJson, callerId));
  return audiences.some((item) => allow.has(item) || item === callerId);
}

export function capExpiryMs(expMs: number, now: number, maxTtlMs: number): number {
  if (!Number.isFinite(expMs)) return now + maxTtlMs;
  return Math.min(Math.max(expMs, now), now + maxTtlMs);
}

export function isDcrClient(clientId: string, registrationHash: string | null | undefined): boolean {
  return Boolean(registrationHash) || clientId.startsWith("cid_");
}

export function mayPostLogoutRedirect(clientId: string, registrationHash: string | null | undefined): boolean {
  return !isDcrClient(clientId, registrationHash);
}

export function upstreamEmailVerified(claims: { email_verified?: boolean | string; xms_edov?: boolean | string }): boolean {
  if (claims.email_verified === true || claims.email_verified === "true") return true;
  return claims.xms_edov === true || claims.xms_edov === "1" || claims.xms_edov === "true";
}

export function microsoftIssuerOk(iss: string, tid?: string): boolean {
  if (tid && /^[0-9a-f-]{36}$/i.test(tid)) return iss === `https://login.microsoftonline.com/${tid}/v2.0`;
  return /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i.test(iss);
}

export function upstreamIdOk(
  claims: { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; email?: string; sub?: string; email_verified?: boolean | string; xms_edov?: boolean | string; tid?: string },
  expected: { issuer?: string; clientId: string; nonce?: string; nowSec: number; microsoft?: boolean },
): boolean {
  if (!claims.sub || !claims.email) return false;
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!aud.includes(expected.clientId)) return false;
  if (typeof claims.exp !== "number" || claims.exp <= expected.nowSec) return false;
  if (expected.nonce && claims.nonce !== expected.nonce) return false;
  if (!upstreamEmailVerified(claims)) return false;
  if (expected.microsoft) return microsoftIssuerOk(claims.iss ?? "", claims.tid);
  if (expected.issuer && claims.iss !== expected.issuer) return false;
  return true;
}

export function shouldRotateLocalPassword(emailVerified: number | boolean): boolean {
  return emailVerified === 0 || emailVerified === false;
}

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

export const PAR_CLAIM_SQL = "DELETE FROM par_requests WHERE request_uri = ? AND client_id = ? AND expires_at > ? RETURNING payload";
export const FED_CLAIM_SQL = "DELETE FROM fed_states WHERE state = ? AND expires_at > ? RETURNING payload";
