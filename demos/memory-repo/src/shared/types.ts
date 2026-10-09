export type TopicPath = "people.md" | "preferences.md" | "projects.md";
export type MemoryPath = "MEMORY.md" | TopicPath;

export type MemoryWrite = {
  path: TopicPath;
  add: string[];
};

export type RecallHit = {
  path: string;
  snippet: string;
  score: number;
};

export type CommitSummary = {
  hash: string;
  message: string;
  authorName: string;
  authoredAt: number;
  parents: string[];
};

export type FileDiff = {
  path: string;
  status: "added" | "modified" | "deleted";
  patch: string;
};

export type DreamStep = {
  label: string;
  detail: string;
};

export type DreamView = {
  id: string;
  status: "committed" | "skipped";
  reason: string;
  commitHash: string | null;
  message: string | null;
  steps: DreamStep[];
  createdAt: number;
};

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  recalled: RecallHit[];
  commitHash: string | null;
  commitMessage: string | null;
};

export type MemoryFile = {
  path: MemoryPath;
  body: string;
};

export type SessionPayload = {
  siteKey: string | null;
  ttlHours: number;
  ready: boolean;
  expiresAt: number | null;
  repoName: string | null;
};

export type StatePayload = {
  expiresAt: number;
  remote: string;
  repoName: string;
  /** True when this dev session has no Artifacts login and commits stay in the Durable Object. */
  local: boolean;
  files: MemoryFile[];
  commits: CommitSummary[];
  messages: ChatMessage[];
  dream: DreamView | null;
};

export type ChatResult = {
  reply: string;
  recalled: RecallHit[];
  committed: boolean;
  commitHash: string | null;
  commitMessage: string | null;
  paths: string[];
  fallback: boolean;
};

export type CommitDetail = {
  hash: string;
  message: string;
  parent: string | null;
  files: FileDiff[];
};
