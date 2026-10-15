import type { CommitDetail } from "../shared/types";

const memory = new Map<string, { at: number; body: CommitDetail }>();
const TTL_MS = 86_400_000;
export const MEMORY_LIMIT = 48;

function pruneMemory(now = Date.now()): void {
  for (const [key, hit] of memory) {
    if (now - hit.at > TTL_MS) memory.delete(key);
  }
  while (memory.size > MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

export function commitCacheSize(): number {
  return memory.size;
}

export function resetCommitCache(): void {
  memory.clear();
}

function cacheKey(repoName: string, hash: string): string {
  return `https://repo-per-agent.cache/commits/${encodeURIComponent(repoName)}/${hash}`;
}

export async function readCommitCache(repoName: string, hash: string): Promise<CommitDetail | null> {
  const key = cacheKey(repoName, hash);
  try {
    const cached = await caches.default.match(key);
    if (cached) return (await cached.json()) as CommitDetail;
  } catch {
    // caches.default is missing in some local harnesses.
  }
  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    memory.delete(key);
    return null;
  }
  return hit.body;
}

export async function writeCommitCache(repoName: string, hash: string, detail: CommitDetail): Promise<void> {
  const key = cacheKey(repoName, hash);
  memory.delete(key);
  memory.set(key, { at: Date.now(), body: detail });
  pruneMemory();
  try {
    await caches.default.put(
      key,
      new Response(JSON.stringify(detail), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
      }),
    );
  } catch {
    // Memory map is enough for tests.
  }
}
