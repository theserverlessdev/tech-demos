export type TaskSummary = {
  id: string;
  title: string;
  remote: string;
  createdAt: number;
  expiresAt: number;
};

export type ActivityRow = {
  id: string;
  kind: "created" | "commit" | "token";
  commitHash: string | null;
  message: string;
  createdAt: number;
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

export type SessionPayload = {
  siteKey: string | null;
  ttlSeconds: number;
  maxTasks: number;
  tasks: TaskSummary[];
};

export type TaskDetail = {
  task: TaskSummary;
  commits: CommitSummary[];
  activity: ActivityRow[];
};

export type CommitDetail = {
  hash: string;
  message: string;
  parent: string | null;
  files: FileDiff[];
};

export type RunResult = {
  hash: string;
  message: string;
  path: string;
};

export type CloneToken = {
  remote: string;
  expiresAt: string;
  /** Read token. The UI keeps it masked. Smoke checks the prefix only. */
  token: string;
  ttlSeconds: number;
};
