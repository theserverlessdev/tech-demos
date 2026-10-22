import { ACCESS_TTL_SEC, CODE_TTL_MS, REFRESH_TTL_MS, SAMPLE_CLIENT_ID, SESSION_TTL_MS, USER_TTL_MS } from "../shared/types";
import { randomBytes, randomId, sha256Hex, toBase64Url } from "./encoding";
import { parseRedirectUris } from "./redirect";

const LOCAL_REDIRECTS = ["http://127.0.0.1:8788/", "http://localhost:8788/"];

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  created_at: number;
  expires_at: number;
  email_verified: number;
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
  family_id: string | null;
  resource: string | null;
  auth_time: number | null;
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
  resource: string | null;
  auth_time: number | null;
};

export async function getApp(db: D1Database, clientId: string): Promise<AppRow | null> {
  return db.prepare("SELECT * FROM apps WHERE client_id = ?").bind(clientId).first<AppRow>();
}

export async function appRedirects(db: D1Database, clientId: string): Promise<string[]> {
  const app = await getApp(db, clientId);
  return app ? parseRedirectUris(app.redirect_uris) : [];
}

export async function ensureLocalApp(db: D1Database, now: number): Promise<void> {
  const app = await getApp(db, SAMPLE_CLIENT_ID);
  const current = app ? parseRedirectUris(app.redirect_uris) : [];
  const merged = [...new Set([...current, ...LOCAL_REDIRECTS])];
  if (!app) {
    await db
      .prepare("INSERT INTO apps (id, client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("app_sample", SAMPLE_CLIENT_ID, "Sample app", JSON.stringify(merged), now)
      .run();
    return;
  }
  if (LOCAL_REDIRECTS.some((uri) => !current.includes(uri))) {
    await db.prepare("UPDATE apps SET redirect_uris = ? WHERE client_id = ?").bind(JSON.stringify(merged), SAMPLE_CLIENT_ID).run();
  }
}

export async function getUserByEmail(db: D1Database, email: string, now: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ? AND expires_at > ?").bind(email, now).first<UserRow>();
}

export async function getUserById(db: D1Database, id: string, now: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ? AND expires_at > ?").bind(id, now).first<UserRow>();
}

export async function deleteExpiredUserByEmail(db: D1Database, email: string, now: number): Promise<void> {
  await db.prepare("DELETE FROM users WHERE email = ? AND expires_at <= ?").bind(email, now).run();
}

export async function createUser(
  db: D1Database,
  email: string,
  hash: string,
  salt: string,
  now: number,
  emailVerified = false,
): Promise<UserRow> {
  const row: UserRow = {
    id: randomId("usr"),
    email,
    password_hash: hash,
    salt,
    created_at: now,
    expires_at: now + USER_TTL_MS,
    email_verified: emailVerified ? 1 : 0,
  };
  await db
    .prepare("INSERT INTO users (id, email, password_hash, salt, created_at, expires_at, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.email, row.password_hash, row.salt, row.created_at, row.expires_at, row.email_verified)
    .run();
  return row;
}

export async function createSession(db: D1Database, userId: string, now: number): Promise<string> {
  const raw = toBase64Url(randomBytes(32));
  await db
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(raw), userId, now, now + SESSION_TTL_MS)
    .run();
  return raw;
}

export async function sessionUser(db: D1Database, sessionId: string, now: number): Promise<UserRow | null> {
  if (!sessionId) return null;
  return db
    .prepare(
      "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ? AND users.expires_at > ?",
    )
    .bind(await sha256Hex(sessionId), now, now)
    .first<UserRow>();
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  if (!sessionId) return;
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(sessionId)).run();
}

export async function issueAuthCode(
  db: D1Database,
  input: {
    userId: string;
    clientId: string;
    redirectUri: string;
    challenge: string;
    nonce: string;
    scope: string;
    now: number;
    resource?: string;
    authTime?: number;
  },
): Promise<string> {
  const code = toBase64Url(randomBytes(32));
  const codeHash = await sha256Hex(code);
  await db
    .prepare(
      "INSERT INTO auth_codes (id, code_hash, user_id, client_id, redirect_uri, code_challenge, nonce, scope, expires_at, used_at, family_id, resource, auth_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
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
      input.resource ?? null,
      input.authTime ?? Math.floor(input.now / 1000),
    )
    .run();
  return code;
}

export async function lookupCode(db: D1Database, code: string): Promise<CodeRow | null> {
  const codeHash = await sha256Hex(code);
  return db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").bind(codeHash).first<CodeRow>();
}

export async function claimCode(db: D1Database, code: string, now: number): Promise<CodeRow | null> {
  const codeHash = await sha256Hex(code);
  const claimed = await db
    .prepare("UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, codeHash, now)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    const existing = await db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").bind(codeHash).first<CodeRow>();
    if (existing?.used_at != null && existing.family_id) {
      await revokeFamily(db, existing.family_id, now);
    }
    return null;
  }
  return db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").bind(codeHash).first<CodeRow>();
}

export async function attachCodeFamily(db: D1Database, codeId: string, familyId: string): Promise<void> {
  await db.prepare("UPDATE auth_codes SET family_id = ? WHERE id = ?").bind(familyId, codeId).run();
}

export async function issueRefresh(
  db: D1Database,
  input: { userId: string; clientId: string; scope: string; familyId?: string; now: number; resource?: string | null; authTime?: number | null },
): Promise<{ token: string; id: string; familyId: string }> {
  const token = toBase64Url(randomBytes(32));
  const id = randomId("rt");
  const familyId = input.familyId ?? randomId("fam");
  await db
    .prepare(
      "INSERT INTO refresh_tokens (id, token_hash, family_id, user_id, client_id, scope, expires_at, revoked_at, replaced_by, resource, auth_time) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
    )
    .bind(
      id,
      await sha256Hex(token),
      familyId,
      input.userId,
      input.clientId,
      input.scope,
      input.now + REFRESH_TTL_MS,
      input.resource ?? null,
      input.authTime ?? null,
    )
    .run();
  return { token, id, familyId };
}

export async function lookupRefresh(db: D1Database, token: string): Promise<RefreshRow | null> {
  return db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").bind(await sha256Hex(token)).first<RefreshRow>();
}

export async function rotateRefreshAtomic(
  db: D1Database,
  row: RefreshRow,
  now: number,
): Promise<{ token: string; id: string; familyId: string } | null> {
  const token = toBase64Url(randomBytes(32));
  const id = randomId("rt");
  const results = await db.batch([
    db
      .prepare("UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?")
      .bind(now, id, row.id, now),
    db
      .prepare(
        "INSERT INTO refresh_tokens (id, token_hash, family_id, user_id, client_id, scope, expires_at, revoked_at, replaced_by, resource, auth_time) SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM refresh_tokens WHERE id = ? AND replaced_by = ?)",
      )
      .bind(
        id,
        await sha256Hex(token),
        row.family_id,
        row.user_id,
        row.client_id,
        row.scope,
        now + REFRESH_TTL_MS,
        row.resource ?? null,
        row.auth_time ?? null,
        row.id,
        id,
      ),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    await revokeFamily(db, row.family_id, now);
    return null;
  }
  return { token, id, familyId: row.family_id };
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

export async function purgeExpired(
  db: D1Database,
  now: number,
): Promise<{ users: number; codes: number; sessions: number; refresh: number; extras: number }> {
  const results = await db.batch([
    db.prepare("DELETE FROM auth_codes WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)").bind(now, now - 3600_000),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM refresh_tokens WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM auth_codes WHERE user_id IN (SELECT id FROM users WHERE expires_at < ?)").bind(now),
    db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE expires_at < ?)").bind(now),
    db.prepare("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE expires_at < ?)").bind(now),
    db.prepare("DELETE FROM users WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM device_grants WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM par_requests WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM revoked_jtis WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM consents WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM apps WHERE expires_at IS NOT NULL AND expires_at < ? AND client_id NOT IN ('melody-sample', 'melody-machine')").bind(now),
    db.prepare("DELETE FROM fed_states WHERE expires_at < ?").bind(now),
  ]);
  return {
    codes: (results[0]?.meta.changes ?? 0) + (results[3]?.meta.changes ?? 0),
    sessions: (results[1]?.meta.changes ?? 0) + (results[4]?.meta.changes ?? 0),
    refresh: (results[2]?.meta.changes ?? 0) + (results[5]?.meta.changes ?? 0),
    users: results[6]?.meta.changes ?? 0,
    extras:
      (results[7]?.meta.changes ?? 0) +
      (results[8]?.meta.changes ?? 0) +
      (results[9]?.meta.changes ?? 0) +
      (results[10]?.meta.changes ?? 0) +
      (results[11]?.meta.changes ?? 0) +
      (results[12]?.meta.changes ?? 0),
  };
}

export { ACCESS_TTL_SEC };
