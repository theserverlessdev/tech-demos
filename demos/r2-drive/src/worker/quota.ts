import { checkFinder, contentDisposition, isFinderNoise, safeFilename, sniff } from "../shared/content-policy";
import { MAX_DRIVE_BYTES, MAX_FILE_BYTES, MAX_FILES, MAX_KEY_BYTES } from "../shared/constants";
import { DavStatus, type DavBucket, type DavObject, type PutOptions } from "./bucket";
import { sha256Hex } from "./crypto";

export type Quota = { bytes: number; files: number };

const COLLECTION = "<collection />";
const encoder = new TextEncoder();

export type SqlRunner = {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

export function ensureQuotaTable(sql: SqlRunner): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS quota (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    bytes INTEGER NOT NULL,
    files INTEGER NOT NULL
  )`);
}

/**
 * One SQLite update reserves or releases. The WHERE clause is the cap.
 * A failed statement changes nothing.
 */
export class SqliteQuota {
  constructor(private readonly sql: SqlRunner) {
    ensureQuotaTable(sql);
    this.sql.exec("INSERT INTO quota (id, bytes, files) VALUES (1, 0, 0) ON CONFLICT(id) DO NOTHING");
  }

  apply(bytes: number, files: number): boolean {
    if (bytes === 0 && files === 0) return true;
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(files)) return false;
    const rows = this.sql
      .exec(
        `UPDATE quota SET bytes = bytes + ?, files = files + ?
         WHERE id = 1
           AND bytes + ? <= ?
           AND files + ? <= ?
           AND bytes + ? >= 0
           AND files + ? >= 0
         RETURNING bytes, files`,
        bytes,
        files,
        bytes,
        MAX_DRIVE_BYTES,
        files,
        MAX_FILES,
        bytes,
        files,
      )
      .toArray() as Quota[];
    return rows.length === 1;
  }

  snapshot(): Quota {
    const row = this.sql.exec("SELECT bytes, files FROM quota WHERE id = 1").toArray()[0] as Quota | undefined;
    return { bytes: row?.bytes ?? 0, files: row?.files ?? 0 };
  }
}

export class GuardedBucket implements DavBucket {
  constructor(
    private readonly inner: DavBucket,
    private readonly quota: SqliteQuota,
    private readonly audit: (row: { key: string; sha256: string; size: number }) => Promise<void>,
  ) {}

  head(key: string): Promise<DavObject | null> {
    return this.inner.head(key);
  }

  get(key: string, options?: { onlyIf?: Headers; range?: Headers }): Promise<DavObject | null> {
    return this.inner.get(key, options);
  }

  list(options?: { prefix?: string; delimiter?: string; cursor?: string; limit?: number }) {
    return this.inner.list(options);
  }

  async put(key: string, body: Uint8Array, options?: PutOptions): Promise<DavObject | null> {
    if (encoder.encode(key).byteLength > MAX_KEY_BYTES) throw new DavStatus(414, "URI Too Long");
    if (body.byteLength > MAX_FILE_BYTES) throw new DavStatus(413, "File is over 5 MB");
    const collection = options?.customMetadata?.resourcetype === COLLECTION;
    const finder = !collection && isFinderNoise(key);
    let httpMetadata = options?.httpMetadata;
    if (finder) {
      const decision = checkFinder(key, body);
      if (!decision.ok) throw new DavStatus(decision.status, decision.reason);
      httpMetadata = {
        contentType: "application/octet-stream",
        contentDisposition: contentDisposition(safeFilename(key), false),
      };
    } else if (!collection) {
      const decision = await sniff(body);
      if (!decision.ok) throw new DavStatus(415, decision.reason);
      httpMetadata = {
        contentType: decision.mediaType,
        contentDisposition: contentDisposition(safeFilename(key), decision.inline),
      };
    }
    const existing = await this.inner.head(key);
    const previous = existing ? await this.inner.get(key) : null;
    const previousBytes = previous ? await objectBytes(previous) : null;
    const credit = options?.quotaCredit ?? { bytes: 0, files: 0 };
    const deltaBytes = body.byteLength - (existing?.size ?? 0) - credit.bytes;
    const deltaFiles = (existing ? 0 : 1) - credit.files;
    const reserveBytes = Math.max(0, deltaBytes);
    const reserveFiles = Math.max(0, deltaFiles);
    if ((reserveBytes || reserveFiles) && !this.quota.apply(reserveBytes, reserveFiles)) {
      const snap = this.quota.snapshot();
      if (snap.bytes + reserveBytes > MAX_DRIVE_BYTES) throw new DavStatus(413, "Drive is over the 25 MB cap");
      throw new DavStatus(413, "Drive is over the 200 file cap");
    }
    let stored: DavObject | null = null;
    try {
      stored = await this.inner.put(key, body, { ...options, httpMetadata });
      if (!stored) {
        this.release(reserveBytes, reserveFiles);
        return null;
      }
      await this.audit({ key, sha256: await sha256Hex(body), size: body.byteLength });
    } catch (error) {
      if (stored) {
        await this.inner.delete(key);
        if (existing && previousBytes) {
          await this.inner.put(key, previousBytes, {
            httpMetadata: existing.httpMetadata,
            customMetadata: existing.customMetadata,
          });
        }
      }
      this.release(reserveBytes, reserveFiles);
      throw error;
    }
    const releaseBytes = Math.max(0, -deltaBytes);
    const releaseFiles = Math.max(0, -deltaFiles);
    if ((releaseBytes || releaseFiles) && !this.quota.apply(-releaseBytes, -releaseFiles)) {
      console.error(JSON.stringify({ event: "quota_release_failed", key }));
    }
    return stored;
  }

  async delete(keys: string | string[], skipQuota = false): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    let bytes = 0;
    let files = 0;
    if (!skipQuota) {
      for (const key of list) {
        const existing = await this.inner.head(key);
        if (!existing) continue;
        bytes += existing.size;
        files += 1;
      }
      if ((bytes || files) && !this.quota.apply(-bytes, -files)) throw new DavStatus(400, "Bad quota");
    }
    try {
      await this.inner.delete(list);
    } catch (error) {
      if (!skipQuota) this.release(-bytes, -files);
      throw error;
    }
  }

  private release(bytes: number, files: number): void {
    if (!bytes && !files) return;
    if (!this.quota.apply(-bytes, -files)) console.error(JSON.stringify({ event: "quota_release_failed", bytes, files }));
  }
}

async function objectBytes(object: DavObject): Promise<Uint8Array> {
  if (object.body instanceof Uint8Array) return object.body;
  if (object.body) return new Uint8Array(await new Response(object.body).arrayBuffer());
  return new Uint8Array();
}
