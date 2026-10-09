import type { CommitSummary } from "../shared/types";

/** Control-plane handle. File bytes move through Git smart HTTP, not this binding. */
export type ArtifactsRepo = {
  info(): Promise<{ name?: string; remote?: string; defaultBranch?: string } | null>;
  createToken(scope?: "read" | "write", ttlSeconds?: number): Promise<{ plaintext: string; expiresAt?: string }>;
  revokeToken(tokenOrId: string): Promise<unknown>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<CommitMeta[]>;
  readCommit(hash: string): Promise<CommitMeta | null>;
  readTree(hash: string): Promise<TreeEntry[] | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  [Symbol.dispose]?: () => void;
  [Symbol.asyncDispose]?: () => Promise<void>;
};

export type CommitMeta = {
  hash: string;
  treeHash: string;
  message: string;
  parents: string[];
  authoredAt: number;
  author?: { name?: string; email?: string };
};

export type TreeEntry = {
  name: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
};

export type CreatedRepo = {
  name: string;
  remote: string;
  defaultBranch?: string;
  token?: string | { plaintext?: string };
};

export type ArtifactsBinding = {
  create(name: string, opts?: { description?: string; readOnly?: boolean; setDefaultBranch?: string }): Promise<CreatedRepo>;
  get(name: string): Promise<ArtifactsRepo>;
  delete(name: string): Promise<unknown>;
  list(opts?: { limit?: number; cursor?: string }): Promise<{ repos?: { name: string; status?: string }[] }>;
};

/** Bindings from `wrangler types`. Artifacts is cast at the call site because the generated type is broader. */
export interface DemoEnv extends Env {}

export function artifactsBinding(env: DemoEnv): ArtifactsBinding | null {
  const value = env.ARTIFACTS as unknown;
  if (!value || typeof value !== "object" || !("create" in value)) return null;
  return value as ArtifactsBinding;
}

export type { CommitSummary };
