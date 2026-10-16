import { ACCESS_TTL_SEC, CODE_TTL_MS, REFRESH_TTL_MS, SESSION_TTL_MS, USER_TTL_MS } from "../shared/types";
import { randomBytes, randomId, sha256Hex, toBase64Url } from "./encoding";
import { parseRedirectUris } from "./redirect";

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  created_at: number;
  expires_at: number;
};

export type AppRow = {
  id: string;
  client_id: string;
  name: string;
  redirect_uris: string;
  created_at: number;
};

export type CodeRow = {
  id: string;
  code_hash: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  nonce: string;
  scope: string;
  expires_at: number;
  used_at: number | null;
};

export type RefreshRow = {
  id: string;
  token_hash: string;
  family_id: string;
  user_id: string;
  client_id: string;
  scope: string;
  expires_at: number;
  revoked_at: number | null;
  replaced_by: string | null;
};

export async function getApp(db: D1Database, clientId: string): Promise<AppRow | null> {
  return db.prepare("SELECT * FROM apps WHERE client_id = ?").bind(clientId).first<AppRow>();
}

export async function appRedirects(db: D1Database, clientId: string): Promise<string[]> {
  const app = await getApp(db, clientId);
  return app ? parseRedirectUris(app.redirect_uris) : [];
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function createUser(db: D1Database, email: string, hash: string, salt: string, now: number): Promise<UserRow> {
  const row: UserRow = {
    id: randomId("usr"),
    email,
    password_hash: hash,
    salt,
    created_at: now,
    expires_at: now + USER_TTL_MS,
  };
  await db
    .prepare("INSERT INTO users (id, email, password_hash, salt, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.email, row.password_hash, row.salt, row.created_at, row.expires_at)
    .run();
  return row;
}

export async function createSession(db: D1Database, userId: string, now: number): Promise<string> {
  const id = toBase64Url(randomBytes(32));
  await db
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, userId, now, now + SESSION_TTL_MS)
    .run();
  return id;
}

export async function sessionUser(db: D1Database, sessionId: string, now: number): Promise<UserRow | null> {
  const session = await db
    .prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?")
    .bind(sessionId, now)
    .first<{ user_id: string }>();
  if (!session) return null;
  return getUserById(db, session.user_id);
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

export async function issueAuthCode(
  db: D1Database,
  input: { userId: string; clientId: string; redirectUri: string; challenge: string; nonce: string; scope: string; now: number },
): Promise<string> {
  const code = toBase64Url(randomBytes(32));
  const codeHash = await sha256Hex(code);
  await db
    .prepare(
      "INSERT INTO auth_codes (id, code_hash, user_id, client_id, redirect_uri, code_challenge, nonce, scope, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(
      randomId("code"),
      codeHash,
      input.userId,
      input.clientId,
      input.redirectUri,
      input.challenge,
      input.nonce,
      input.scope,
      input.now + CODE_TTL_MS,
    )
    .run();
  return code;
}

export async function lookupCode(db: D1Database, code: string): Promise<CodeRow | null> {
  const codeHash = await sha256Hex(code);
  return db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").bind(codeHash).first<CodeRow>();
}

export async function markCodeUsed(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE auth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, id).run();
}

export async function issueRefresh(
  db: D1Database,
  input: { userId: string; clientId: string; scope: string; familyId?: string; now: number },
): Promise<{ token: string; id: string; familyId: string }> {
  const token = toBase64Url(randomBytes(32));
  const id = randomId("rt");
  const familyId = input.familyId ?? randomId("fam");
  await db
    .prepare(
      "INSERT INTO refresh_tokens (id, token_hash, family_id, user_id, client_id, scope, expires_at, revoked_at, replaced_by) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
    )
    .bind(id, await sha256Hex(token), familyId, input.userId, input.clientId, input.scope, input.now + REFRESH_TTL_MS)
    .run();
  return { token, id, familyId };
}

export async function lookupRefresh(db: D1Database, token: string): Promise<RefreshRow | null> {
  return db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").bind(await sha256Hex(token)).first<RefreshRow>();
}

export async function rotateRefresh(db: D1Database, oldId: string, newId: string, now: number): Promise<void> {
  await db.prepare("UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ?").bind(now, newId, oldId).run();
}

export async function revokeFamily(db: D1Database, familyId: string, now: number): Promise<void> {
  await db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL").bind(now, familyId).run();
}

export async function listUsers(db: D1Database, now: number): Promise<UserRow[]> {
  const result = await db
    .prepare("SELECT * FROM users WHERE expires_at > ? ORDER BY created_at DESC LIMIT 50")
    .bind(now)
    .all<UserRow>();
  return result.results ?? [];
}

export async function listApps(db: D1Database): Promise<AppRow[]> {
  const result = await db.prepare("SELECT * FROM apps ORDER BY name").all<AppRow>();
  return result.results ?? [];
}

export async function purgeExpired(db: D1Database, now: number): Promise<{ users: number; codes: number; sessions: number; refresh: number }> {
  const codes = await db.prepare("DELETE FROM auth_codes WHERE expires_at < ? OR used_at IS NOT NULL AND used_at < ?").bind(now, now - 3600_000).run();
  const sessions = await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  const refresh = await db.prepare("DELETE FROM refresh_tokens WHERE expires_at < ?").bind(now).run();
  await db.prepare("DELETE FROM auth_codes WHERE user_id IN (SELECT id FROM users WHERE expires_at < ?)").bind(now).run();
  await db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE expires_at < ?)").bind(now).run();
  await db.prepare("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE expires_at < ?)").bind(now).run();
  const users = await db.prepare("DELETE FROM users WHERE expires_at < ?").bind(now).run();
  return {
    users: users.meta.changes ?? 0,
    codes: codes.meta.changes ?? 0,
    sessions: sessions.meta.changes ?? 0,
    refresh: refresh.meta.changes ?? 0,
  };
}

export { ACCESS_TTL_SEC };
