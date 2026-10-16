import { CLIENT_TTL_MS, DEVICE_TTL_MS, MACHINE_CLIENT_ID, PAR_TTL_MS, SAMPLE_CLIENT_ID, USER_TTL_MS } from "../shared/types";
import { randomBytes, randomId, sha256Hex, toBase64Url } from "./encoding";
import { hashPassword } from "./password";
import { hashClientSecret } from "./secret";
import { FED_CLAIM_SQL, PAR_CLAIM_SQL } from "./policy";
import { parseRedirectUris } from "./redirect";
import type { AppRow, UserRow } from "./db";
import { createUser, getApp, getUserByEmail, getUserById } from "./db";

export type FullApp = AppRow & {
  client_secret_hash: string | null;
  client_secret_salt: string | null;
  token_endpoint_auth_method: string;
  grant_types: string;
  scopes: string;
  jwks: string | null;
  client_type: string;
  resources: string | null;
  registration_access_hash: string | null;
  expires_at: number | null;
  require_pkce: number;
  response_types: string;
  post_logout_redirect_uris?: string | null;
};

export type DeviceRow = {
  id: string;
  device_code_hash: string;
  user_code: string;
  client_id: string;
  scope: string;
  audience: string | null;
  expires_at: number;
  interval_sec: number;
  last_poll_at: number | null;
  user_id: string | null;
  denied_at: number | null;
};

export function parseJsonList(raw: string | null | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return fallback;
  }
}

export function appGrants(app: FullApp): string[] {
  return parseJsonList(app.grant_types, ["authorization_code", "refresh_token"]);
}

export function appScopes(app: FullApp): string[] {
  return (app.scopes || "openid profile email offline_access").split(/\s+/).filter(Boolean);
}

export async function getFullApp(db: D1Database, clientId: string): Promise<FullApp | null> {
  return db.prepare("SELECT * FROM apps WHERE client_id = ?").bind(clientId).first<FullApp>();
}

export async function listFullApps(db: D1Database): Promise<FullApp[]> {
  const result = await db.prepare("SELECT * FROM apps ORDER BY name").all<FullApp>();
  return result.results ?? [];
}

export async function insertApp(
  db: D1Database,
  input: {
    clientId: string;
    name: string;
    redirectUris: string[];
    grantTypes: string[];
    scopes: string;
    authMethod: string;
    clientType: string;
    secretHash?: string;
    secretSalt?: string;
    jwks?: string;
    registrationHash?: string;
    now: number;
    expiresAt?: number | null;
    requirePkce?: boolean;
  },
): Promise<FullApp> {
  const id = randomId("app");
  await db
    .prepare(
      `INSERT INTO apps (id, client_id, name, redirect_uris, created_at, client_secret_hash, client_secret_salt, token_endpoint_auth_method, grant_types, scopes, jwks, client_type, resources, registration_access_hash, expires_at, require_pkce, response_types)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '["code"]')`,
    )
    .bind(
      id,
      input.clientId,
      input.name,
      JSON.stringify(input.redirectUris),
      input.now,
      input.secretHash ?? null,
      input.secretSalt ?? null,
      input.authMethod,
      JSON.stringify(input.grantTypes),
      input.scopes,
      input.jwks ?? null,
      input.clientType,
      input.registrationHash ?? null,
      input.expiresAt === undefined ? input.now + CLIENT_TTL_MS : input.expiresAt,
      input.requirePkce === false ? 0 : 1,
    )
    .run();
  const row = await getFullApp(db, input.clientId);
  if (!row) throw new Error("app");
  return row;
}

export async function updateApp(
  db: D1Database,
  clientId: string,
  patch: { name?: string; redirectUris?: string[]; grantTypes?: string[]; scopes?: string; authMethod?: string },
): Promise<void> {
  const current = await getFullApp(db, clientId);
  if (!current) return;
  await db
    .prepare("UPDATE apps SET name = ?, redirect_uris = ?, grant_types = ?, scopes = ?, token_endpoint_auth_method = ? WHERE client_id = ?")
    .bind(
      patch.name ?? current.name,
      JSON.stringify(patch.redirectUris ?? parseRedirectUris(current.redirect_uris)),
      JSON.stringify(patch.grantTypes ?? appGrants(current)),
      patch.scopes ?? current.scopes,
      patch.authMethod ?? current.token_endpoint_auth_method,
      clientId,
    )
    .run();
}

export async function deleteApp(db: D1Database, clientId: string): Promise<void> {
  await db.prepare("DELETE FROM apps WHERE client_id = ?").bind(clientId).run();
}

export async function ensureMachineApp(db: D1Database, now: number, secret: string): Promise<void> {
  const hashed = await hashClientSecret(secret);
  if (await getApp(db, MACHINE_CLIENT_ID)) {
    await db
      .prepare("UPDATE apps SET client_secret_hash = ?, client_secret_salt = '', expires_at = NULL, client_type = 'confidential', token_endpoint_auth_method = 'client_secret_post' WHERE client_id = ?")
      .bind(hashed, MACHINE_CLIENT_ID)
      .run();
    return;
  }
  await insertApp(db, {
    clientId: MACHINE_CLIENT_ID,
    name: "Machine client",
    redirectUris: [],
    grantTypes: ["client_credentials"],
    scopes: "api",
    authMethod: "client_secret_post",
    clientType: "confidential",
    secretHash: hashed,
    secretSalt: "",
    now,
    expiresAt: null,
    requirePkce: false,
  });
}

export async function consentFor(db: D1Database, userId: string, clientId: string, now: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT scope FROM consents WHERE user_id = ? AND client_id = ? AND expires_at > ?")
    .bind(userId, clientId, now)
    .first<{ scope: string }>();
  return row?.scope ?? null;
}

export function scopesCovered(granted: string, requested: string): boolean {
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return requested.split(/\s+/).filter(Boolean).every((scope) => have.has(scope));
}

export async function rememberConsent(db: D1Database, userId: string, clientId: string, scope: string, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO consents (user_id, client_id, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, client_id) DO UPDATE SET scope = excluded.scope, created_at = excluded.created_at, expires_at = excluded.expires_at",
    )
    .bind(userId, clientId, scope, now, now + USER_TTL_MS)
    .run();
}

export function makeUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let raw = "";
  for (const b of bytes) raw += alphabet[b % alphabet.length];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export async function createDeviceGrant(
  db: D1Database,
  input: { clientId: string; scope: string; audience?: string; now: number },
): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
  const deviceCode = toBase64Url(randomBytes(32));
  const userCode = makeUserCode();
  await db
    .prepare(
      "INSERT INTO device_grants (id, device_code_hash, user_code, client_id, scope, audience, expires_at, interval_sec, last_poll_at, user_id, denied_at) VALUES (?, ?, ?, ?, ?, ?, ?, 5, NULL, NULL, NULL)",
    )
    .bind(randomId("dev"), await sha256Hex(deviceCode), userCode, input.clientId, input.scope, input.audience ?? null, input.now + DEVICE_TTL_MS)
    .run();
  return { deviceCode, userCode, expiresIn: DEVICE_TTL_MS / 1000, interval: 5 };
}

export async function lookupDeviceByUserCode(db: D1Database, userCode: string): Promise<DeviceRow | null> {
  return db.prepare("SELECT * FROM device_grants WHERE user_code = ?").bind(userCode.trim().toUpperCase()).first<DeviceRow>();
}

export async function lookupDeviceByCode(db: D1Database, deviceCode: string): Promise<DeviceRow | null> {
  return db.prepare("SELECT * FROM device_grants WHERE device_code_hash = ?").bind(await sha256Hex(deviceCode)).first<DeviceRow>();
}

export async function approveDevice(db: D1Database, id: string, userId: string): Promise<void> {
  await db.prepare("UPDATE device_grants SET user_id = ? WHERE id = ? AND user_id IS NULL AND denied_at IS NULL").bind(userId, id).run();
}

export async function denyDevice(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE device_grants SET denied_at = ? WHERE id = ?").bind(now, id).run();
}

export async function touchDevicePoll(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE device_grants SET last_poll_at = ? WHERE id = ?").bind(now, id).run();
}

export function devicePollStatus(row: DeviceRow | null, now: number): "pending" | "slow_down" | "denied" | "expired" | "ready" | "missing" {
  if (!row) return "missing";
  if (row.expires_at <= now) return "expired";
  if (row.denied_at) return "denied";
  if (row.user_id) return "ready";
  if (row.last_poll_at != null && now - row.last_poll_at < row.interval_sec * 1000) return "slow_down";
  return "pending";
}

export async function savePar(db: D1Database, clientId: string, payload: Record<string, string>, now: number): Promise<{ requestUri: string; expiresIn: number }> {
  const requestUri = `urn:ietf:params:oauth:request_uri:${toBase64Url(randomBytes(24))}`;
  await db
    .prepare("INSERT INTO par_requests (request_uri, client_id, payload, expires_at) VALUES (?, ?, ?, ?)")
    .bind(requestUri, clientId, JSON.stringify(payload), now + PAR_TTL_MS)
    .run();
  return { requestUri, expiresIn: PAR_TTL_MS / 1000 };
}

export async function loadPar(db: D1Database, requestUri: string, clientId: string, now: number): Promise<Record<string, string> | null> {
  const row = await db.prepare(PAR_CLAIM_SQL).bind(requestUri, clientId, now).first<{ payload: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as Record<string, string>;
  } catch {
    return null;
  }
}

export async function revokeJti(db: D1Database, jti: string, expMs: number): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO revoked_jtis (jti, expires_at) VALUES (?, ?)").bind(jti, expMs).run();
}

export async function isJtiRevoked(db: D1Database, jti: string, now: number): Promise<boolean> {
  const row = await db.prepare("SELECT jti FROM revoked_jtis WHERE jti = ? AND expires_at > ?").bind(jti, now).first();
  return Boolean(row);
}

export async function findFederated(db: D1Database, provider: string, sub: string): Promise<{ user_id: string } | null> {
  return db.prepare("SELECT user_id FROM federated_identities WHERE provider = ? AND provider_sub = ?").bind(provider, sub).first<{ user_id: string }>();
}

export async function linkFederated(db: D1Database, provider: string, sub: string, userId: string, email: string, now: number): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO federated_identities (provider, provider_sub, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(provider, sub, userId, email, now)
    .run();
}

export async function userForFederation(db: D1Database, email: string, now: number, linkedUserId: string | null): Promise<UserRow | null> {
  if (linkedUserId) return getUserById(db, linkedUserId, now);
  const existing = await getUserByEmail(db, email, now);
  if (existing) {
    if (!existing.email_verified) {
      const hashed = await hashPassword(toBase64Url(randomBytes(18)));
      await db
        .prepare("UPDATE users SET email_verified = 1, password_hash = ?, salt = ? WHERE id = ?")
        .bind(hashed.hash, hashed.salt, existing.id)
        .run();
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(existing.id),
        db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").bind(existing.id),
        db.prepare("DELETE FROM consents WHERE user_id = ?").bind(existing.id),
      ]);
      existing.email_verified = 1;
      existing.password_hash = hashed.hash;
      existing.salt = hashed.salt;
    }
    return existing;
  }
  const hashed = await hashPassword(toBase64Url(randomBytes(18)));
  return createUser(db, email, hashed.hash, hashed.salt, now, true);
}

export async function countDcrClients(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM apps WHERE registration_access_hash IS NOT NULL").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function rememberClientAssertion(db: D1Database, clientId: string, jti: string, expMs: number): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO revoked_jtis (jti, expires_at) VALUES (?, ?)")
    .bind(`ca:${clientId}:${jti}`, expMs)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function saveFedState(db: D1Database, state: string, payload: string, now: number): Promise<void> {
  await db.prepare("INSERT INTO fed_states (state, payload, expires_at) VALUES (?, ?, ?)").bind(state, payload, now + 600_000).run();
}

export async function claimFedState(db: D1Database, state: string, now: number): Promise<string | null> {
  const row = await db.prepare(FED_CLAIM_SQL).bind(state, now).first<{ payload: string }>();
  return row?.payload ?? null;
}

export async function consumeDevice(db: D1Database, id: string, now: number): Promise<DeviceRow | null> {
  const claimed = await db
    .prepare("UPDATE device_grants SET expires_at = 0 WHERE id = ? AND user_id IS NOT NULL AND denied_at IS NULL AND expires_at > ?")
    .bind(id, now)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return null;
  return db.prepare("SELECT * FROM device_grants WHERE id = ?").bind(id).first<DeviceRow>();
}

export async function bumpDeviceInterval(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE device_grants SET interval_sec = interval_sec + 5 WHERE id = ?").bind(id).run();
}

const PLAYGROUND_REDIRECTS = [
  "https://melody-auth.tech-demos.theserverless.dev/playground.html",
  "http://127.0.0.1:8788/playground.html",
  "http://localhost:8788/playground.html",
];

export async function ensureSampleMeta(db: D1Database, now: number, local: boolean): Promise<void> {
  const app = await getFullApp(db, SAMPLE_CLIENT_ID);
  const extra = local ? PLAYGROUND_REDIRECTS : [PLAYGROUND_REDIRECTS[0]];
  if (!app) return;
  const current = parseRedirectUris(app.redirect_uris);
  const merged = [...new Set([...current, ...extra.filter((uri): uri is string => Boolean(uri))])];
  const grants = appGrants(app);
  const nextGrants = [...new Set([...grants, "urn:ietf:params:oauth:grant-type:device_code"])];
  await db
    .prepare("UPDATE apps SET redirect_uris = ?, grant_types = ?, scopes = ?, post_logout_redirect_uris = ? WHERE client_id = ?")
    .bind(
      JSON.stringify(merged),
      JSON.stringify(nextGrants),
      app.scopes || "openid profile email offline_access api",
      JSON.stringify(merged),
      SAMPLE_CLIENT_ID,
    )
    .run();
  void now;
}

export async function sessionAuthTime(db: D1Database, sessionId: string, now: number): Promise<{ user: UserRow; authTime: number } | null> {
  if (!sessionId) return null;
  const row = await db
    .prepare(
      "SELECT users.*, sessions.created_at AS session_created FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ? AND users.expires_at > ?",
    )
    .bind(await sha256Hex(sessionId), now, now)
    .first<UserRow & { session_created: number }>();
  if (!row) return null;
  return { user: row, authTime: Math.floor(row.session_created / 1000) };
}
