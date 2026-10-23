import { DAV_CSP } from "../shared/constants";
import type { DavBucket } from "./bucket";
import type { LockStore } from "./locks";
import { GuardedBucket, SqliteQuota, type SqlRunner } from "./quota";
import { handleWebdav } from "./webdav";

const MUTATING = new Set(["PUT", "DELETE", "MKCOL", "MOVE", "COPY", "LOCK", "UNLOCK", "PROPPATCH"]);

export class DriveSession {
  private tail: Promise<void> = Promise.resolve();
  readonly quota: SqliteQuota;
  readonly bucket: GuardedBucket;

  constructor(options: {
    sql: SqlRunner;
    bucket: DavBucket;
    locks: LockStore;
    audit: (row: { key: string; sha256: string; size: number }) => Promise<void>;
  }) {
    this.quota = new SqliteQuota(options.sql);
    this.bucket = new GuardedBucket(options.bucket, this.quota, options.audit);
    this.locks = options.locks;
  }

  private readonly locks: LockStore;

  handle(request: Request, mountPath: string, key: string, now: number, expiresAt: number | null): Promise<Response> {
    const run = () => this.dispatch(request, mountPath, key, now, expiresAt);
    if (!MUTATING.has(request.method)) return run();
    const next = this.tail.then(run, run);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async dispatch(request: Request, mountPath: string, key: string, now: number, expiresAt: number | null): Promise<Response> {
    if (expiresAt !== null && now >= expiresAt && MUTATING.has(request.method)) {
      return withDavCsp(new Response("Gone", { status: 410 }));
    }
    const response = await handleWebdav(request, {
      bucket: this.bucket,
      locks: this.locks,
      now,
      mountPath,
      key,
      driveExpiresAt: expiresAt ?? undefined,
    });
    return withDavCsp(response);
  }
}

export function withDavCsp(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", DAV_CSP);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
