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

type IfCondition = { not: boolean; token?: string; etag?: string };

/** True when the If header is absent or one of its applicable lists matches. */
export function ifHeaderAllows(header: string | null, heldTokens: string[], etag: string | undefined, requestUrl: string, resourcePath: string): boolean {
  if (!header || !header.trim()) return true;
  const lists = parseIfLists(header, requestUrl, resourcePath);
  if (!lists) return false;
  if (lists.length === 0) return true;
  const held = new Set(heldTokens);
  return lists.some((list) =>
    list.length > 0 &&
    list.every((condition) => {
      let value = false;
      if (condition.token !== undefined) {
        // RFC 4918 §10.4.8: DAV:no-lock never names a current lock, so it does not match.
        value = held.has(normalizeLockToken(condition.token));
      } else if (condition.etag !== undefined) {
        value = etag !== undefined && condition.etag === etag;
      }
      return condition.not ? !value : value;
    }),
  );
}

function parseIfLists(header: string, requestUrl: string, resourcePath: string): IfCondition[][] | null {
  const lists: IfCondition[][] = [];
  let applies = true;
  let index = 0;
  while (index < header.length) {
    const char = header[index];
    if (char === " " || char === "\t") {
      index += 1;
      continue;
    }
    if (char === "<") {
      const end = header.indexOf(">", index);
      if (end < 0) return null;
      applies = tagApplies(header.slice(index + 1, end), requestUrl, resourcePath);
      index = end + 1;
      continue;
    }
    if (char !== "(") return null;
    index += 1;
    const conditions: IfCondition[] = [];
    while (index < header.length && header[index] !== ")") {
      while (header[index] === " ") index += 1;
      if (header[index] === ")") break;
      let inverted = false;
      if (/^not(?=[ <[])/i.test(header.slice(index))) {
        inverted = true;
        index += 3;
        while (header[index] === " ") index += 1;
      } else if (/^not(?=\))/i.test(header.slice(index))) {
        conditions.push({ not: false, token: "" });
        index += 3;
        continue;
      }
      if (header[index] === "<") {
        const end = header.indexOf(">", index);
        if (end < 0) return null;
        conditions.push({ not: inverted, token: header.slice(index + 1, end) });
        index = end + 1;
      } else if (header[index] === "[") {
        const end = header.indexOf("]", index);
        if (end < 0) return null;
        conditions.push({ not: inverted, etag: header.slice(index + 1, end).trim() });
        index = end + 1;
      } else return null;
      while (header[index] === " ") index += 1;
    }
    if (header[index] !== ")") return null;
    index += 1;
    if (applies) lists.push(conditions);
  }
  return lists;
}

function tagApplies(tag: string, requestUrl: string, resourcePath: string): boolean {
  try {
    const url = new URL(tag, requestUrl);
    const path = url.pathname.replace(/\/+$/, "");
    const resource = resourcePath.replace(/\/+$/, "");
    return path === resource;
  } catch {
    return false;
  }
}

export async function heldLockTokens(store: LockStore, path: string, now: number): Promise<string[]> {
  const tokens: string[] = [];
  for (const candidate of ancestors(path)) {
    for (const lock of await store.get(candidate, now)) {
      if (candidate === path || lock.depth === "infinity") tokens.push(lock.token);
    }
  }
  return tokens;
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
