export type LockScope = "exclusive" | "shared";
export type LockDepth = "0" | "infinity";

export type LockRecord = {
  token: string;
  path: string;
  owner?: string;
  scope: LockScope;
  depth: LockDepth;
  timeout: string;
  expiresAt: number;
  root: string;
};

export interface LockStore {
  get(path: string, now: number): Promise<LockRecord[]>;
  set(path: string, locks: LockRecord[]): Promise<void>;
  list(now: number): Promise<LockRecord[]>;
  clear(): Promise<void>;
}

export class MemoryLockStore implements LockStore {
  private readonly rows = new Map<string, LockRecord[]>();

  async get(path: string, now: number): Promise<LockRecord[]> {
    return (this.rows.get(path) ?? []).filter((lock) => lock.expiresAt > now);
  }

  async set(path: string, locks: LockRecord[]): Promise<void> {
    if (locks.length === 0) this.rows.delete(path);
    else this.rows.set(path, locks);
  }

  async list(now: number): Promise<LockRecord[]> {
    const out: LockRecord[] = [];
    for (const locks of this.rows.values()) out.push(...locks.filter((lock) => lock.expiresAt > now));
    return out;
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }
}

export function ancestors(path: string): string[] {
  const out: string[] = [];
  let current = path;
  for (;;) {
    out.push(current);
    if (!current) break;
    const slash = current.lastIndexOf("/");
    current = slash === -1 ? "" : current.slice(0, slash);
  }
  return out;
}

export async function assertWritable(
  store: LockStore,
  path: string,
  tokens: string[],
  now: number,
  options?: { ignoreSharedLocksOnTarget?: boolean },
): Promise<boolean> {
  for (const candidate of ancestors(path)) {
    const details = (await store.get(candidate, now)).filter(
      (lock) =>
        (candidate === path || lock.depth === "infinity") &&
        !(options?.ignoreSharedLocksOnTarget && candidate === path && lock.scope === "shared"),
    );
    if (details.length === 0) continue;
    if (!details.some((lock) => tokens.includes(lock.token))) return false;
  }
  return true;
}

export async function descendantBlocks(store: LockStore, path: string, tokens: string[], now: number): Promise<boolean> {
  const prefix = path === "" ? "" : `${path}/`;
  for (const lock of await store.list(now)) {
    const inside = path === "" ? lock.path !== "" : lock.path.startsWith(prefix);
    if (!inside) continue;
    if (!tokens.includes(lock.token)) return true;
  }
  return false;
}

export function normalizeLockToken(token: string): string {
  return token
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/^(?:urn:uuid:|opaquelocktoken:)/, "");
}

export function lockTokensFrom(request: Request): string[] {
  const tokens: string[] = [];
  const direct = request.headers.get("Lock-Token");
  if (direct) tokens.push(normalizeLockToken(direct));
  const ifHeader = request.headers.get("If");
  if (ifHeader) {
    for (const match of ifHeader.matchAll(/<([^>]+)>/g)) {
      const token = normalizeLockToken(match[1] ?? "");
      if (token) tokens.push(token);
    }
  }
  return [...new Set(tokens)];
}

export function alwaysFalseIf(request: Request): boolean {
  const header = request.headers.get("If") ?? "";
  return header.includes("<DAV:no-lock>") && !header.includes("Not <DAV:no-lock>");
}

const DEFAULT_LOCK_SECONDS = 3600;
const MAX_LOCK_SECONDS = 365 * 24 * 60 * 60;

export function parseTimeout(header: string | null, now: number): { timeout: string; expiresAt: number } {
  if (!header) return { timeout: `Second-${DEFAULT_LOCK_SECONDS}`, expiresAt: now + DEFAULT_LOCK_SECONDS * 1000 };
  for (const item of header.split(",").map((value) => value.trim())) {
    if (item.toLowerCase() === "infinite") {
      return { timeout: "Infinite", expiresAt: now + MAX_LOCK_SECONDS * 1000 };
    }
    const seconds = Number(/^Second-(\d+)$/i.exec(item)?.[1] ?? NaN);
    if (Number.isFinite(seconds) && seconds > 0) {
      const capped = Math.min(seconds, MAX_LOCK_SECONDS);
      return { timeout: `Second-${capped}`, expiresAt: now + capped * 1000 };
    }
  }
  return { timeout: `Second-${DEFAULT_LOCK_SECONDS}`, expiresAt: now + DEFAULT_LOCK_SECONDS * 1000 };
}

export function lockDiscovery(locks: LockRecord[]): string {
  return locks
    .map(
      (lock) =>
        `<activelock><locktype><write/></locktype><lockscope><${lock.scope}/></lockscope><depth>${lock.depth}</depth>${lock.owner ? `<owner>${escapeXml(lock.owner)}</owner>` : ""}<timeout>${escapeXml(lock.timeout)}</timeout><locktoken><href>urn:uuid:${escapeXml(lock.token)}</href></locktoken><lockroot><href>${escapeXml(lock.root)}</href></lockroot></activelock>`,
    )
    .join("");
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function supportedLockXml(): string {
  return "<lockentry><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockentry><lockentry><lockscope><shared/></lockscope><locktype><write/></locktype></lockentry>";
}
