import type { DemoEnv } from "./env";

export type VisitorRow = {
  id: string;
  threadId: string;
  repoName: string;
  remote: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
};

type VisitorRecord = {
  id: string;
  thread_id: string;
  repo_name: string;
  remote: string;
  created_at: number;
  last_activity_at: number;
  expires_at: number;
};

function mapRow(row: VisitorRecord): VisitorRow {
  return {
    id: row.id,
    threadId: row.thread_id,
    repoName: row.repo_name,
    remote: row.remote,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
  };
}

const COLUMNS = "id, thread_id, repo_name, remote, created_at, last_activity_at, expires_at";

export async function getVisitor(env: DemoEnv, id: string, now: number): Promise<VisitorRow | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM visitors WHERE id = ? AND expires_at > ?`).bind(id, now).first<VisitorRecord>();
  return row ? mapRow(row) : null;
}

export async function upsertVisitor(env: DemoEnv, row: VisitorRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO visitors (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       thread_id = excluded.thread_id,
       repo_name = excluded.repo_name,
       remote = excluded.remote,
       last_activity_at = excluded.last_activity_at,
       expires_at = excluded.expires_at`,
  )
    .bind(row.id, row.threadId, row.repoName, row.remote, row.createdAt, row.lastActivityAt, row.expiresAt)
    .run();
}

export async function touchVisitor(env: DemoEnv, id: string, lastActivityAt: number, expiresAt: number): Promise<void> {
  await env.DB.prepare("UPDATE visitors SET last_activity_at = ?, expires_at = ? WHERE id = ?").bind(lastActivityAt, expiresAt, id).run();
}

export async function deleteVisitor(env: DemoEnv, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM visitors WHERE id = ?").bind(id).run();
}

export async function listExpired(env: DemoEnv, now: number, limit: number): Promise<VisitorRow[]> {
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM visitors WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?`)
    .bind(now, limit)
    .all<VisitorRecord>();
  return results.map(mapRow);
}
