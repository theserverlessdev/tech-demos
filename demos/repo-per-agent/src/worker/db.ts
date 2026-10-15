import type { ActivityRow, CommitSummary, TaskSummary } from "../shared/types";
import type { DemoEnv } from "./env";

type TaskRecord = {
  id: string;
  visitor_id: string;
  repo_name: string;
  title: string;
  remote: string;
  created_at: number;
  expires_at: number;
  attempts?: number;
};

function summary(row: TaskRecord): TaskSummary {
  return {
    id: row.id,
    title: row.title,
    remote: row.remote,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function countLiveTasks(env: DemoEnv, visitorId: string, now: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE visitor_id = ? AND expires_at > ?")
    .bind(visitorId, now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countAllLiveTasks(env: DemoEnv, now: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE expires_at > ?")
    .bind(now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Reserve a task row only if the visitor and global live caps still have room. */
export async function reserveTask(
  env: DemoEnv,
  task: { id: string; visitorId: string; repoName: string; title: string; remote: string; createdAt: number; expiresAt: number },
  maxVisitor: number,
  maxLive: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO tasks (id, visitor_id, repo_name, title, remote, created_at, expires_at, attempts)
     SELECT ?, ?, ?, ?, ?, ?, ?, 0
     WHERE (SELECT COUNT(*) FROM tasks WHERE visitor_id = ? AND expires_at > ?) < ?
       AND (SELECT COUNT(*) FROM tasks WHERE expires_at > ?) < ?`,
  )
    .bind(
      task.id,
      task.visitorId,
      task.repoName,
      task.title,
      task.remote,
      task.createdAt,
      task.expiresAt,
      task.visitorId,
      task.createdAt,
      maxVisitor,
      task.createdAt,
      maxLive,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function updateTaskRemote(env: DemoEnv, id: string, remote: string): Promise<void> {
  await env.DB.prepare("UPDATE tasks SET remote = ? WHERE id = ?").bind(remote, id).run();
}

export async function insertTask(
  env: DemoEnv,
  task: { id: string; visitorId: string; repoName: string; title: string; remote: string; createdAt: number; expiresAt: number },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO tasks (id, visitor_id, repo_name, title, remote, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
  )
    .bind(task.id, task.visitorId, task.repoName, task.title, task.remote, task.createdAt, task.expiresAt)
    .run();
}

export async function listTasks(env: DemoEnv, visitorId: string, now: number): Promise<TaskSummary[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, visitor_id, repo_name, title, remote, created_at, expires_at FROM tasks WHERE visitor_id = ? AND expires_at > ? ORDER BY created_at DESC",
  )
    .bind(visitorId, now)
    .all<TaskRecord>();
  return results.map(summary);
}

export async function getTask(env: DemoEnv, visitorId: string, id: string, now: number): Promise<(TaskSummary & { repoName: string }) | null> {
  const row = await env.DB.prepare(
    "SELECT id, visitor_id, repo_name, title, remote, created_at, expires_at FROM tasks WHERE id = ? AND visitor_id = ? AND expires_at > ?",
  )
    .bind(id, visitorId, now)
    .first<TaskRecord>();
  if (!row) return null;
  return { ...summary(row), repoName: row.repo_name };
}

export async function insertActivity(
  env: DemoEnv,
  row: { id: string; taskId: string; kind: ActivityRow["kind"]; commitHash: string | null; message: string; createdAt: number },
): Promise<void> {
  await env.DB.prepare("INSERT INTO activity (id, task_id, kind, commit_hash, message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.taskId, row.kind, row.commitHash, row.message, row.createdAt)
    .run();
}

export async function listActivity(env: DemoEnv, taskId: string): Promise<ActivityRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, kind, commit_hash, message, created_at FROM activity WHERE task_id = ? ORDER BY created_at DESC LIMIT 40",
  )
    .bind(taskId)
    .all<{ id: string; kind: ActivityRow["kind"]; commit_hash: string | null; message: string; created_at: number }>();
  return results.map((row) => ({
    id: row.id,
    kind: row.kind,
    commitHash: row.commit_hash,
    message: row.message,
    createdAt: row.created_at,
  }));
}

/** Commit list for the task pane. Activity already stores hash + message; skip Artifacts `log`. */
export async function listCommitSummaries(env: DemoEnv, taskId: string): Promise<CommitSummary[]> {
  const { results } = await env.DB.prepare(
    "SELECT commit_hash, message, created_at FROM activity WHERE task_id = ? AND commit_hash IS NOT NULL ORDER BY created_at DESC LIMIT 20",
  )
    .bind(taskId)
    .all<{ commit_hash: string; message: string; created_at: number }>();
  return results.map((row) => ({
    hash: row.commit_hash,
    message: row.message,
    authorName: "Task Agent",
    authoredAt: row.created_at,
    parents: [],
  }));
}

export async function listExpired(env: DemoEnv, now: number, limit: number): Promise<{ id: string; repoName: string; attempts: number }[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, repo_name, COALESCE(attempts, 0) AS attempts FROM tasks WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?",
  )
    .bind(now, limit)
    .all<{ id: string; repo_name: string; attempts: number }>();
  return results.map((row) => ({ id: row.id, repoName: row.repo_name, attempts: row.attempts }));
}

export async function bumpCleanup(env: DemoEnv, taskId: string, attempts: number, now: number): Promise<void> {
  const delay = Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts, 6));
  await env.DB.prepare("UPDATE tasks SET attempts = ?, expires_at = ? WHERE id = ?")
    .bind(attempts + 1, now + delay, taskId)
    .run();
}

export async function deleteTaskRows(env: DemoEnv, taskId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM activity WHERE task_id = ?").bind(taskId).run();
  await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(taskId).run();
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function claimAiCall(env: DemoEnv, now: number, cap: number): Promise<boolean> {
  const day = utcDay(now);
  const result = await env.DB.prepare(
    `INSERT INTO ai_daily (day, n) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET n = n + 1
     WHERE n < ?`,
  )
    .bind(day, cap)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
