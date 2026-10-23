import { contentDisposition, safeFilename, sniff } from "../shared/content-policy";
import { MAX_DRIVE_BYTES, MAX_FILE_BYTES, MAX_FILES } from "../shared/constants";
import { DavStatus, type DavBucket, type DavObject, type PutOptions } from "./bucket";
import { sha256Hex } from "./crypto";

export type Quota = { bytes: number; files: number };

const COLLECTION = "<collection />";

export class GuardedBucket implements DavBucket {
  constructor(
    private readonly inner: DavBucket,
    private readonly quota: Quota,
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
    if (body.byteLength > MAX_FILE_BYTES) throw new DavStatus(413, "File is over 5 MB");
    const collection = options?.customMetadata?.resourcetype === COLLECTION;
    let httpMetadata = options?.httpMetadata;
    if (!collection) {
      const decision = sniff(body);
      if (!decision.ok) throw new DavStatus(415, decision.reason);
      httpMetadata = {
        contentType: decision.mediaType,
        contentDisposition: contentDisposition(safeFilename(key), decision.inline),
      };
    }
    const existing = await this.inner.head(key);
    const credit = options?.quotaCredit ?? { bytes: 0, files: 0 };
    const nextBytes = this.quota.bytes - (existing?.size ?? 0) - credit.bytes + body.byteLength;
    const nextFiles = this.quota.files - (existing ? 1 : 0) - credit.files + 1;
    if (nextBytes > MAX_DRIVE_BYTES) throw new DavStatus(413, "Drive is over the 25 MB cap");
    if (nextFiles > MAX_FILES) throw new DavStatus(413, "Drive is over the 200 file cap");
    if (nextBytes < 0 || nextFiles < 0) throw new DavStatus(400, "Bad quota");
    const stored = await this.inner.put(key, body, { ...options, httpMetadata });
    if (!stored) return null;
    try {
      await this.audit({ key, sha256: await sha256Hex(body), size: body.byteLength });
    } catch (error) {
      await this.inner.delete(key);
      if (existing) {
        await this.inner.put(key, existing.body instanceof Uint8Array ? existing.body : new Uint8Array(), {
          httpMetadata: existing.httpMetadata,
          customMetadata: existing.customMetadata,
        });
      }
      throw error;
    }
    this.quota.bytes = nextBytes;
    this.quota.files = nextFiles;
    return stored;
  }

  async delete(keys: string | string[], skipQuota = false): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    if (!skipQuota) {
      for (const key of list) {
        const existing = await this.inner.head(key);
        if (!existing) continue;
        this.quota.bytes = Math.max(0, this.quota.bytes - existing.size);
        this.quota.files = Math.max(0, this.quota.files - 1);
      }
    }
    await this.inner.delete(list);
  }
}
