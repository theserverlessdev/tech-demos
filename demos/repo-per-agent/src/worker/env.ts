import type { ActivityRow, CommitSummary, TaskSummary } from "../shared/types";

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

/** Bindings from `wrangler types`. The Artifacts aliases below are the subset this worker calls. */
export interface DemoEnv extends Env {
  /** Production secret. Not a wrangler var, so generated Env omits it. Missing means Turnstile fails closed. */
  TURNSTILE_SECRET?: string;
}

export type { ActivityRow, CommitSummary, TaskSummary };
