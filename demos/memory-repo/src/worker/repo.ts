import type { CommitSummary } from "../shared/types";
import type { ArtifactsBinding, ArtifactsRepo, CommitMeta, TreeEntry } from "./env";
import { MEMORY_AUTHOR } from "./memory-files";
import { pushCommit } from "./git";

export function tokenPlaintext(token: unknown): string {
  if (typeof token === "string" && token.startsWith("art_")) return token;
  if (token && typeof token === "object" && "plaintext" in token) {
    const plaintext = (token as { plaintext?: unknown }).plaintext;
    if (typeof plaintext === "string" && plaintext.startsWith("art_")) return plaintext;
  }
  throw new Error("Artifacts did not return a git token");
}

export async function withRepo<T>(artifacts: ArtifactsBinding, name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
  const repo = await artifacts.get(name);
  try {
    return await fn(repo);
  } finally {
    await repo[Symbol.asyncDispose]?.();
    repo[Symbol.dispose]?.();
  }
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

export function asCommits(value: unknown): CommitMeta[] {
  if (!Array.isArray(value)) return [];
  const commits: CommitMeta[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const hash = stringField(record, ["hash", "sha"]);
    const treeHash = stringField(record, ["treeHash", "tree"]);
    if (!hash || !treeHash) continue;
    const author = record.author;
    commits.push({
      hash,
      treeHash,
      message: typeof record.message === "string" ? record.message : "",
      parents: Array.isArray(record.parents) ? record.parents.filter((parent): parent is string => typeof parent === "string") : [],
      authoredAt: typeof record.authoredAt === "number" ? record.authoredAt : 0,
      author: author && typeof author === "object" ? (author as CommitMeta["author"]) : undefined,
    });
  }
  return commits;
}

function asEntries(value: unknown): TreeEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: TreeEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = stringField(record, ["name", "path"]);
    const hash = stringField(record, ["hash", "sha", "oid"]);
    if (!name || !hash) continue;
    const mode = typeof record.mode === "string" ? record.mode : "";
    const declared = typeof record.type === "string" ? record.type : "";
    const type: TreeEntry["type"] =
      declared === "tree" || mode === "40000" || mode === "040000"
        ? "tree"
        : declared === "exec" || mode === "100755"
          ? "exec"
          : "blob";
    entries.push({ name, mode, hash, type });
  }
  return entries;
}

export function toSummary(commit: CommitMeta): CommitSummary {
  const message = commit.message.replace(/\n[\s\S]*$/, "").trim();
  return {
    hash: commit.hash,
    message,
    authorName: commit.author?.name || "Memory Agent",
    authoredAt: commit.authoredAt,
    parents: commit.parents,
  };
}

export async function headCommit(repo: ArtifactsRepo): Promise<CommitMeta | null> {
  const history = asCommits(await repo.log({ ref: "main", limit: 1 }));
  return history[0] ?? null;
}

/** `readFile` resolves a full path against a commit ref. Tree walks only discover the paths. */
export async function readFilesAt(repo: ArtifactsRepo, ref: string): Promise<Map<string, string>> {
  const commit = asCommits([await repo.readCommit(ref)])[0];
  if (!commit) return new Map();
  const paths = await listPaths(repo, commit.treeHash, "");
  const files = new Map<string, string>();
  for (const path of paths) {
    const blob = await repo.readFile({ ref, path });
    if (!blob) continue;
    const text = await blob.text();
    if (!text.includes("\0")) files.set(path, text);
  }
  return files;
}

async function listPaths(repo: ArtifactsRepo, treeHash: string, prefix: string): Promise<string[]> {
  const entries = asEntries(await repo.readTree(treeHash));
  const paths: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === "tree") paths.push(...(await listPaths(repo, entry.hash, path)));
    else if (entry.type === "blob" || entry.type === "exec") paths.push(path);
    if (paths.length > 8) break;
  }
  return paths;
}

export async function commitFiles(opts: {
  artifacts: ArtifactsBinding;
  repoName: string;
  remote: string;
  token: string;
  parent: string | null;
  files: Record<string, string>;
  message: string;
}): Promise<string> {
  return pushCommit({
    remote: opts.remote,
    token: opts.token,
    parent: opts.parent,
    files: opts.files,
    message: opts.message,
    author: { ...MEMORY_AUTHOR, timestamp: Math.floor(Date.now() / 1000) },
  });
}

export async function revokeQuiet(artifacts: ArtifactsBinding, repoName: string, token: string): Promise<void> {
  try {
    await withRepo(artifacts, repoName, (repo) => repo.revokeToken(token));
  } catch (err) {
    console.warn(JSON.stringify({ event: "token_revoke_failed", repo: repoName, error: String(err).slice(0, 180) }));
  }
}
