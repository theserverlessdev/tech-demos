import { safeRelativeKey } from "../shared/paths";

export type HttpMeta = {
  contentType?: string;
  contentDisposition?: string;
  contentLanguage?: string;
  contentEncoding?: string;
};

export type DavObject = {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
  httpMetadata?: HttpMeta;
  customMetadata?: Record<string, string>;
  body?: Uint8Array | ReadableStream;
  range?: { offset?: number; length?: number; suffix?: number };
  preconditionFailed?: boolean;
};

export type PutOptions = {
  httpMetadata?: HttpMeta;
  customMetadata?: Record<string, string>;
  onlyIf?: Headers;
  quotaCredit?: { bytes: number; files: number };
};

export interface DavBucket {
  head(key: string): Promise<DavObject | null>;
  get(key: string, options?: { onlyIf?: Headers; range?: Headers }): Promise<DavObject | null>;
  put(key: string, body: Uint8Array, options?: PutOptions): Promise<DavObject | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; delimiter?: string; cursor?: string; limit?: number }): Promise<{
    objects: DavObject[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export class DavStatus extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type R2Like = {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Objects>;
};

export function adaptR2(bucket: R2Like): DavBucket {
  return {
    async head(key) {
      const object = await bucket.head(key);
      return object ? fromR2(object) : null;
    },
    async get(key, options) {
      const object = await bucket.get(key, { onlyIf: options?.onlyIf, range: options?.range });
      if (!object) return null;
      if (!("body" in object)) return { ...fromR2(object), preconditionFailed: true };
      return { ...fromR2(object), body: object.body, range: object.range };
    },
    async put(key, body, options) {
      const object = await bucket.put(key, body, {
        onlyIf: options?.onlyIf,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      });
      return object ? fromR2(object, body) : null;
    },
    delete(keys) {
      return bucket.delete(keys);
    },
    async list(options) {
      const page = await bucket.list({
        prefix: options?.prefix,
        delimiter: options?.delimiter,
        cursor: options?.cursor,
        limit: options?.limit,
        include: ["httpMetadata", "customMetadata"],
      });
      return {
        objects: page.objects.map((object) => fromR2(object)),
        truncated: page.truncated,
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
  };
}

function fromR2(object: R2Object, body?: Uint8Array): DavObject {
  return {
    key: object.key,
    size: object.size,
    uploaded: object.uploaded,
    etag: object.etag,
    httpMetadata: object.httpMetadata
      ? {
          contentType: object.httpMetadata.contentType,
          contentDisposition: object.httpMetadata.contentDisposition,
          contentLanguage: object.httpMetadata.contentLanguage,
          contentEncoding: object.httpMetadata.contentEncoding,
        }
      : undefined,
    customMetadata: object.customMetadata,
    body,
  };
}

export class MemoryBucket implements DavBucket {
  private readonly objects = new Map<string, DavObject>();

  async head(key: string): Promise<DavObject | null> {
    const found = this.objects.get(key);
    return found ? { ...found, body: undefined } : null;
  }

  async get(key: string, options?: { onlyIf?: Headers; range?: Headers }): Promise<DavObject | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    const failed = precondition(found.etag, options?.onlyIf);
    if (failed) return { ...found, body: undefined, preconditionFailed: true };
    const body = found.body instanceof Uint8Array ? found.body : new Uint8Array();
    const ranged = sliceRange(body, options?.range);
    return { ...found, body: ranged.body, size: found.size, range: ranged.range };
  }

  async put(key: string, body: Uint8Array, options?: PutOptions): Promise<DavObject | null> {
    const existing = this.objects.get(key);
    if (existing && precondition(existing.etag, options?.onlyIf)) return null;
    const stored: DavObject = {
      key,
      size: body.byteLength,
      uploaded: new Date(),
      etag: await etagOf(body),
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata ? { ...options.customMetadata } : undefined,
      body,
    };
    this.objects.set(key, stored);
    return { ...stored, body: undefined };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options?: { prefix?: string; delimiter?: string; cursor?: string }): Promise<{
    objects: DavObject[];
    truncated: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? "";
    let keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    if (options?.delimiter) {
      keys = keys.filter((key) => !key.slice(prefix.length).includes(options.delimiter as string));
    }
    return { objects: keys.map((key) => ({ ...this.objects.get(key)!, body: undefined })), truncated: false };
  }
}

export class PrefixBucket implements DavBucket {
  constructor(
    private readonly inner: DavBucket,
    private readonly prefix: string,
  ) {}

  private full(key: string): string {
    if (!safeRelativeKey(key)) throw new DavStatus(400, "Bad path");
    return this.prefix + key;
  }

  async head(key: string): Promise<DavObject | null> {
    if (key === "") return null;
    const object = await this.inner.head(this.full(key));
    return object ? { ...object, key } : null;
  }

  async get(key: string, options?: { onlyIf?: Headers; range?: Headers }): Promise<DavObject | null> {
    if (key === "") return null;
    const object = await this.inner.get(this.full(key), options);
    return object ? { ...object, key } : null;
  }

  async put(key: string, body: Uint8Array, options?: PutOptions): Promise<DavObject | null> {
    const object = await this.inner.put(this.full(key), body, options);
    return object ? { ...object, key } : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = (Array.isArray(keys) ? keys : [keys]).map((key) => this.full(key));
    await this.inner.delete(list);
  }

  async list(options?: { prefix?: string; delimiter?: string; cursor?: string; limit?: number }) {
    const page = await this.inner.list({
      prefix: this.prefix + (options?.prefix ?? ""),
      delimiter: options?.delimiter,
      cursor: options?.cursor,
      limit: options?.limit,
    });
    return {
      ...page,
      objects: page.objects.map((object) => ({ ...object, key: object.key.slice(this.prefix.length) })),
    };
  }
}

export async function deletePrefix(bucket: DavBucket, prefix: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      removed += keys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

function precondition(etag: string, headers?: Headers): boolean {
  if (!headers) return false;
  const match = headers.get("if-match");
  if (match && match !== "*" && !match.split(",").some((part) => part.trim() === etag)) return true;
  const none = headers.get("if-none-match");
  if (none && (none === "*" || none.split(",").some((part) => part.trim() === etag))) return true;
  return false;
}

function sliceRange(body: Uint8Array, header?: Headers): { body: Uint8Array; range?: DavObject["range"] } {
  const raw = header?.get("range");
  if (!raw) return { body };
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match) return { body };
  const size = body.byteLength;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
    return { body: body.subarray(start, end + 1), range: { suffix } };
  }
  end = Math.min(end, size - 1);
  if (start > end || start >= size) return { body: new Uint8Array(), range: { offset: start, length: 0 } };
  return { body: body.subarray(start, end + 1), range: { offset: start, length: end - start + 1 } };
}

async function etagOf(body: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  let hex = "";
  for (const byte of digest.subarray(0, 8)) hex += byte.toString(16).padStart(2, "0");
  return `"${hex}"`;
}
