import { FROZEN_KEEP_MS } from "../shared/constants";

export type DriveStatus = "active" | "frozen" | "wiped";

export type DriveRow = {
  id: string;
  emailHmac: string;
  emailEnc: string;
  ipHmac: string;
  networkHmac: string;
  createdAt: number;
  expiresAt: number;
  wipedAt: number | null;
  frozenAt: number | null;
  status: DriveStatus;
  passwordHash: string;
  passwordSalt: string;
  sessionHash: string | null;
  bytesUsed: number;
  fileCount: number;
  aupVersion: string;
};

export type VerificationRow = {
  tokenHash: string;
  emailHmac: string;
  emailEnc: string;
  ipHmac: string;
  networkHmac: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  aupVersion: string;
  devToken: string | null;
};

export type ObjectRow = {
  driveId: string;
  key: string;
  sha256: string;
  size: number;
  firstSeen: number;
};

export interface DriveRepo {
  mintKilled(): Promise<boolean>;
  setMintKilled(killed: boolean): Promise<void>;
  tryIncrementDaily(kind: "mint" | "email", day: string, cap: number): Promise<boolean>;
  insertVerification(row: VerificationRow): Promise<void>;
  deleteVerification(tokenHash: string): Promise<void>;
  takeVerification(tokenHash: string, now: number): Promise<VerificationRow | null>;
  latestDevToken(): Promise<string | null>;
  findLiveByEmail(emailHmac: string, now: number): Promise<DriveRow | null>;
  findExpiredByEmail(emailHmac: string, now: number): Promise<DriveRow | null>;
  insertDrive(row: DriveRow): Promise<void>;
  getDrive(id: string): Promise<DriveRow | null>;
  findBySession(sessionHash: string): Promise<DriveRow | null>;
  freeze(id: string, now: number): Promise<boolean>;
  markWiped(id: string, now: number): Promise<void>;
  updateUsage(id: string, bytes: number, files: number): Promise<void>;
  addObject(row: ObjectRow): Promise<void>;
  listObjects(driveId: string): Promise<ObjectRow[]>;
  listExpired(now: number): Promise<DriveRow[]>;
  purge(before: number): Promise<void>;
  block(kind: "email" | "network", hmac: string, reason: string, now: number): Promise<void>;
  unblock(kind: "email" | "network", hmac: string): Promise<void>;
  blocked(kind: "email" | "network", hmac: string): Promise<boolean>;
  addReport(row: { driveId: string | null; reason: string; contactEnc: string | null; ipHmac: string; createdAt: number }): Promise<void>;
}

export class MemoryRepo implements DriveRepo {
  drives: DriveRow[] = [];
  verifications: VerificationRow[] = [];
  objects: ObjectRow[] = [];
  blocks: { kind: "email" | "network"; hmac: string; reason: string; createdAt: number }[] = [];
  reports: { driveId: string | null; reason: string; contactEnc: string | null; ipHmac: string; createdAt: number }[] = [];
  killed = false;
  daily = new Map<string, number>();

  async mintKilled(): Promise<boolean> {
    return this.killed;
  }
  async setMintKilled(killed: boolean): Promise<void> {
    this.killed = killed;
  }
  async tryIncrementDaily(kind: "mint" | "email", day: string, cap: number): Promise<boolean> {
    const key = `${kind}:${day}`;
    const count = this.daily.get(key) ?? 0;
    if (count >= cap) return false;
    this.daily.set(key, count + 1);
    return true;
  }
  async insertVerification(row: VerificationRow): Promise<void> {
    this.verifications.push(row);
  }
  async deleteVerification(tokenHash: string): Promise<void> {
    this.verifications = this.verifications.filter((row) => row.tokenHash !== tokenHash);
  }
  async takeVerification(tokenHash: string, now: number): Promise<VerificationRow | null> {
    const row = this.verifications.find((item) => item.tokenHash === tokenHash && item.usedAt === null && item.expiresAt > now);
    if (!row) return null;
    row.usedAt = now;
    return row;
  }
  async latestDevToken(): Promise<string | null> {
    for (let i = this.verifications.length - 1; i >= 0; i--) {
      const token = this.verifications[i]?.devToken;
      if (token && this.verifications[i]?.usedAt === null) return token;
    }
    return null;
  }
  async findLiveByEmail(emailHmac: string, now: number): Promise<DriveRow | null> {
    return this.drives.find((row) => row.emailHmac === emailHmac && holdsSlot(row, now)) ?? null;
  }
  async findExpiredByEmail(emailHmac: string, now: number): Promise<DriveRow | null> {
    return this.drives.find((row) => row.emailHmac === emailHmac && row.status === "active" && row.expiresAt <= now) ?? null;
  }
  async insertDrive(row: DriveRow): Promise<void> {
    if (this.drives.some((item) => item.emailHmac === row.emailHmac && item.status !== "wiped")) {
      throw new Error("email_in_use");
    }
    this.drives.push(row);
  }
  async getDrive(id: string): Promise<DriveRow | null> {
    return this.drives.find((row) => row.id === id) ?? null;
  }
  async findBySession(sessionHash: string): Promise<DriveRow | null> {
    return this.drives.find((row) => row.sessionHash === sessionHash && row.status !== "wiped") ?? null;
  }
  async freeze(id: string, now: number): Promise<boolean> {
    const row = await this.getDrive(id);
    if (!row || row.status === "wiped") return false;
    row.status = "frozen";
    row.frozenAt = now;
    return true;
  }
  async markWiped(id: string, now: number): Promise<void> {
    const row = await this.getDrive(id);
    if (!row || row.status === "wiped") return;
    row.status = "wiped";
    row.wipedAt = now;
    row.sessionHash = null;
    row.bytesUsed = 0;
    row.fileCount = 0;
  }
  async updateUsage(id: string, bytes: number, files: number): Promise<void> {
    const row = await this.getDrive(id);
    if (!row || row.status === "wiped") return;
    row.bytesUsed = bytes;
    row.fileCount = files;
  }
  async addObject(row: ObjectRow): Promise<void> {
    const existing = this.objects.find((item) => item.driveId === row.driveId && item.key === row.key && item.sha256 === row.sha256);
    if (!existing) this.objects.push(row);
  }
  async listObjects(driveId: string): Promise<ObjectRow[]> {
    return this.objects.filter((row) => row.driveId === driveId);
  }
  async listExpired(now: number): Promise<DriveRow[]> {
    return this.drives.filter((row) => dueForWipe(row, now));
  }
  async purge(before: number): Promise<void> {
    const ids = new Set(this.drives.filter((row) => row.wipedAt !== null && row.wipedAt < before).map((row) => row.id));
    this.drives = this.drives.filter((row) => !ids.has(row.id));
    this.objects = this.objects.filter((row) => !ids.has(row.driveId));
    this.verifications = this.verifications.filter((row) => row.createdAt >= before);
    this.reports = this.reports.filter((row) => row.createdAt >= before);
  }
  async block(kind: "email" | "network", hmac: string, reason: string, now: number): Promise<void> {
    if (this.blocks.some((row) => row.kind === kind && row.hmac === hmac)) return;
    this.blocks.push({ kind, hmac, reason, createdAt: now });
  }
  async unblock(kind: "email" | "network", hmac: string): Promise<void> {
    this.blocks = this.blocks.filter((row) => !(row.kind === kind && row.hmac === hmac));
  }
  async blocked(kind: "email" | "network", hmac: string): Promise<boolean> {
    return this.blocks.some((row) => row.kind === kind && row.hmac === hmac);
  }
  async addReport(row: { driveId: string | null; reason: string; contactEnc: string | null; ipHmac: string; createdAt: number }): Promise<void> {
    this.reports.push(row);
  }
}

type D1Value = string | number | null;

export class D1Repo implements DriveRepo {
  constructor(private readonly db: D1Database) {}

  async mintKilled(): Promise<boolean> {
    const row = await this.db.prepare("SELECT value FROM settings WHERE key = 'mint_killed'").first<{ value: string }>();
    return row?.value === "1";
  }
  async setMintKilled(killed: boolean): Promise<void> {
    await this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('mint_killed', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1")
      .bind(killed ? "1" : "0")
      .run();
  }
  async tryIncrementDaily(kind: "mint" | "email", day: string, cap: number): Promise<boolean> {
    const table = kind === "mint" ? "mint_daily" : "email_daily";
    const row = await this.db
      .prepare(
        `INSERT INTO ${table} (day, count) VALUES (?1, 1)
         ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < ?2
         RETURNING count`,
      )
      .bind(day, cap)
      .first<{ count: number }>();
    return row !== null;
  }
  async insertVerification(row: VerificationRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO verifications (token_hash, email_hmac, email_enc, ip_hmac, network_hmac, created_at, expires_at, used_at, aup_version, dev_token)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9)`,
      )
      .bind(row.tokenHash, row.emailHmac, row.emailEnc, row.ipHmac, row.networkHmac, row.createdAt, row.expiresAt, row.aupVersion, row.devToken)
      .run();
  }
  async deleteVerification(tokenHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM verifications WHERE token_hash = ?1").bind(tokenHash).run();
  }
  async takeVerification(tokenHash: string, now: number): Promise<VerificationRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM verifications WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2")
      .bind(tokenHash, now)
      .first<Record<string, D1Value>>();
    if (!row) return null;
    const updated = await this.db
      .prepare("UPDATE verifications SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL")
      .bind(tokenHash, now)
      .run();
    if (!updated.meta.changes) return null;
    return mapVerification(row);
  }
  async latestDevToken(): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT dev_token FROM verifications WHERE dev_token IS NOT NULL AND used_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .first<{ dev_token: string }>();
    return row?.dev_token ?? null;
  }
  async findLiveByEmail(emailHmac: string, now: number): Promise<DriveRow | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM drives WHERE email_hmac = ?1 AND (
           (status = 'active' AND expires_at > ?2) OR
           (status = 'frozen' AND frozen_at IS NOT NULL AND frozen_at + ?3 > ?2)
         ) LIMIT 1`,
      )
      .bind(emailHmac, now, FROZEN_KEEP_MS)
      .first<Record<string, D1Value>>();
    return row ? mapDrive(row) : null;
  }
  async findExpiredByEmail(emailHmac: string, now: number): Promise<DriveRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM drives WHERE email_hmac = ?1 AND status = 'active' AND expires_at <= ?2 LIMIT 1")
      .bind(emailHmac, now)
      .first<Record<string, D1Value>>();
    return row ? mapDrive(row) : null;
  }
  async insertDrive(row: DriveRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO drives (
           id, email_hmac, email_enc, ip_hmac, network_hmac, created_at, expires_at, wiped_at, frozen_at, status,
           password_hash, password_salt, session_hash, bytes_used, file_count, aup_version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .bind(
        row.id,
        row.emailHmac,
        row.emailEnc,
        row.ipHmac,
        row.networkHmac,
        row.createdAt,
        row.expiresAt,
        row.status,
        row.passwordHash,
        row.passwordSalt,
        row.sessionHash,
        row.bytesUsed,
        row.fileCount,
        row.aupVersion,
      )
      .run();
  }
  async getDrive(id: string): Promise<DriveRow | null> {
    const row = await this.db.prepare("SELECT * FROM drives WHERE id = ?1").bind(id).first<Record<string, D1Value>>();
    return row ? mapDrive(row) : null;
  }
  async findBySession(sessionHash: string): Promise<DriveRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM drives WHERE session_hash = ?1 AND status != 'wiped' LIMIT 1")
      .bind(sessionHash)
      .first<Record<string, D1Value>>();
    return row ? mapDrive(row) : null;
  }
  async freeze(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE drives SET status = 'frozen', frozen_at = ?2 WHERE id = ?1 AND status != 'wiped'")
      .bind(id, now)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
  async markWiped(id: string, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE drives SET status = 'wiped', wiped_at = ?2, session_hash = NULL, bytes_used = 0, file_count = 0 WHERE id = ?1 AND status != 'wiped'")
      .bind(id, now)
      .run();
  }
  async updateUsage(id: string, bytes: number, files: number): Promise<void> {
    await this.db.prepare("UPDATE drives SET bytes_used = ?2, file_count = ?3 WHERE id = ?1 AND status != 'wiped'").bind(id, bytes, files).run();
  }
  async addObject(row: ObjectRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO objects (drive_id, key, sha256, size, first_seen) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(drive_id, key, sha256) DO NOTHING`,
      )
      .bind(row.driveId, row.key, row.sha256, row.size, row.firstSeen)
      .run();
  }
  async listObjects(driveId: string): Promise<ObjectRow[]> {
    const result = await this.db.prepare("SELECT * FROM objects WHERE drive_id = ?1 ORDER BY first_seen").bind(driveId).all<Record<string, D1Value>>();
    return result.results.map(mapObject);
  }
  async listExpired(now: number): Promise<DriveRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM drives WHERE
           (status = 'active' AND expires_at <= ?1) OR
           (status = 'frozen' AND frozen_at IS NOT NULL AND frozen_at <= ?2)`,
      )
      .bind(now, now - FROZEN_KEEP_MS)
      .all<Record<string, D1Value>>();
    return result.results.map(mapDrive);
  }
  async purge(before: number): Promise<void> {
    const expired = await this.db.prepare("SELECT id FROM drives WHERE wiped_at IS NOT NULL AND wiped_at < ?1").bind(before).all<{ id: string }>();
    const ids = expired.results.map((row) => row.id);
    if (ids.length) {
      const marks = ids.map(() => "?").join(", ");
      await this.db.prepare(`DELETE FROM objects WHERE drive_id IN (${marks})`).bind(...ids).run();
      await this.db.prepare(`DELETE FROM drives WHERE id IN (${marks})`).bind(...ids).run();
    }
    await this.db.prepare("DELETE FROM verifications WHERE created_at < ?1").bind(before).run();
    await this.db.prepare("DELETE FROM reports WHERE created_at < ?1").bind(before).run();
  }
  async block(kind: "email" | "network", hmac: string, reason: string, now: number): Promise<void> {
    await this.db
      .prepare("INSERT INTO blocks (kind, hmac, reason, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(kind, hmac) DO NOTHING")
      .bind(kind, hmac, reason, now)
      .run();
  }
  async unblock(kind: "email" | "network", hmac: string): Promise<void> {
    await this.db.prepare("DELETE FROM blocks WHERE kind = ?1 AND hmac = ?2").bind(kind, hmac).run();
  }
  async blocked(kind: "email" | "network", hmac: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT hmac FROM blocks WHERE kind = ?1 AND hmac = ?2").bind(kind, hmac).first();
    return row !== null;
  }
  async addReport(row: { driveId: string | null; reason: string; contactEnc: string | null; ipHmac: string; createdAt: number }): Promise<void> {
    await this.db
      .prepare("INSERT INTO reports (drive_id, reason, contact_enc, ip_hmac, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(row.driveId, row.reason, row.contactEnc, row.ipHmac, row.createdAt)
      .run();
  }
}

function num(value: D1Value): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function str(value: D1Value): string {
  return typeof value === "string" ? value : "";
}

function holdsSlot(row: DriveRow, now: number): boolean {
  if (row.status === "active") return row.expiresAt > now;
  if (row.status === "frozen") return row.frozenAt !== null && row.frozenAt + FROZEN_KEEP_MS > now;
  return false;
}

function dueForWipe(row: DriveRow, now: number): boolean {
  if (row.status === "active") return row.expiresAt <= now;
  if (row.status === "frozen") return row.frozenAt !== null && row.frozenAt + FROZEN_KEEP_MS <= now;
  return false;
}

function mapDrive(row: Record<string, D1Value>): DriveRow {
  const status = str(row.status);
  return {
    id: str(row.id),
    emailHmac: str(row.email_hmac),
    emailEnc: str(row.email_enc),
    ipHmac: str(row.ip_hmac),
    networkHmac: str(row.network_hmac),
    createdAt: num(row.created_at),
    expiresAt: num(row.expires_at),
    wipedAt: row.wiped_at === null ? null : num(row.wiped_at),
    frozenAt: row.frozen_at === null ? null : num(row.frozen_at),
    status: status === "frozen" || status === "wiped" ? status : "active",
    passwordHash: str(row.password_hash),
    passwordSalt: str(row.password_salt),
    sessionHash: row.session_hash === null ? null : str(row.session_hash),
    bytesUsed: num(row.bytes_used),
    fileCount: num(row.file_count),
    aupVersion: str(row.aup_version),
  };
}

function mapVerification(row: Record<string, D1Value>): VerificationRow {
  return {
    tokenHash: str(row.token_hash),
    emailHmac: str(row.email_hmac),
    emailEnc: str(row.email_enc),
    ipHmac: str(row.ip_hmac),
    networkHmac: str(row.network_hmac),
    createdAt: num(row.created_at),
    expiresAt: num(row.expires_at),
    usedAt: row.used_at === null ? null : num(row.used_at),
    aupVersion: str(row.aup_version),
    devToken: row.dev_token === null ? null : str(row.dev_token),
  };
}

function mapObject(row: Record<string, D1Value>): ObjectRow {
  return {
    driveId: str(row.drive_id),
    key: str(row.key),
    sha256: str(row.sha256),
    size: num(row.size),
    firstSeen: num(row.first_seen),
  };
}
