import { LIMITS } from "../shared/limits";
import type { ChoiceQuestion, JudgmentResult, JudgmentView, Modality } from "../shared/types";

export type MediaRow = {
  id: string;
  visitor_id: string;
  kind: Modality;
  content_type: string;
  bytes: number;
  duration_ms: number | null;
  r2_key: string;
  created_at: number;
  expires_at: number;
};

export type JudgmentRow = {
  id: string;
  visitor_id: string;
  media_id: string | null;
  sample_id: string | null;
  pair_id: string | null;
  kind: "omni" | "compare";
  modality: Modality;
  label: string;
  ip_key: string;
  questions_json: string;
  result_json: string;
  status: "pending" | "complete" | "error";
  error: string | null;
  latency_ms: number;
  source: string;
  cost_usd: number | null;
  created_at: number;
  expires_at: number;
};

const MEDIA_COLUMNS = "id, visitor_id, kind, content_type, bytes, duration_ms, r2_key, created_at, expires_at";
const JUDGMENT_COLUMNS = "id, visitor_id, media_id, sample_id, pair_id, kind, modality, label, ip_key, questions_json, result_json, status, error, latency_ms, source, cost_usd, created_at, expires_at";

async function countWhere(env: Env, sql: string, ...binds: (string | number)[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function countRecentVisitor(env: Env, visitorId: string, since: number): Promise<number> {
  return countWhere(env, "SELECT COUNT(*) AS n FROM judgments WHERE visitor_id = ? AND created_at >= ?", visitorId, since);
}

export async function countRecentIp(env: Env, ipKey: string, since: number): Promise<number> {
  return countWhere(env, "SELECT COUNT(*) AS n FROM judgments WHERE ip_key = ? AND created_at >= ?", ipKey, since);
}

export async function countSince(env: Env, since: number): Promise<number> {
  return countWhere(env, "SELECT COUNT(*) AS n FROM judgments WHERE created_at >= ?", since);
}

export async function insertMedia(env: Env, row: Omit<MediaRow, "created_at" | "expires_at"> & { now: number }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO media (id, visitor_id, kind, content_type, bytes, duration_ms, r2_key, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(row.id, row.visitor_id, row.kind, row.content_type, row.bytes, row.duration_ms, row.r2_key, row.now, row.now + LIMITS.retentionMs)
    .run();
}

export async function getMedia(env: Env, id: string, now: number): Promise<MediaRow | null> {
  return env.DB.prepare(`SELECT ${MEDIA_COLUMNS} FROM media WHERE id = ? AND expires_at > ?`).bind(id, now).first<MediaRow>();
}

/**
 * One statement. The row is inserted only while the visitor, the network,
 * and the rolling day are all under their caps.
 */
export async function insertJudgment(
  env: Env,
  row: {
    id: string;
    visitorId: string;
    mediaId: string | null;
    sampleId: string | null;
    pairId: string | null;
    kind: "omni" | "compare";
    modality: Modality;
    label: string;
    ipKey: string;
    questionsJson: string;
    now: number;
  },
): Promise<boolean> {
  const sinceHour = row.now - 60 * 60 * 1000;
  const sinceDay = row.now - LIMITS.retentionMs;
  const result = await env.DB.prepare(
    `INSERT INTO judgments (id, visitor_id, media_id, sample_id, pair_id, kind, modality, label, ip_key, questions_json, result_json, status, latency_ms, source, created_at, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'pending', 0, '', ?, ?
     WHERE (SELECT COUNT(*) FROM judgments WHERE visitor_id = ? AND created_at >= ?) < ?
       AND (SELECT COUNT(*) FROM judgments WHERE ip_key = ? AND created_at >= ?) < ?
       AND (SELECT COUNT(*) FROM judgments WHERE created_at >= ?) < ?`,
  )
    .bind(
      row.id,
      row.visitorId,
      row.mediaId,
      row.sampleId,
      row.pairId,
      row.kind,
      row.modality,
      row.label,
      row.ipKey,
      row.questionsJson,
      row.now,
      row.now + LIMITS.retentionMs,
      row.visitorId,
      sinceHour,
      LIMITS.perVisitorHour,
      row.ipKey,
      sinceHour,
      LIMITS.perNetworkHour,
      sinceDay,
      LIMITS.dailyCap,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function finishJudgment(env: Env, id: string, result: JudgmentResult, costUsd: number | null): Promise<void> {
  await env.DB.prepare(
    `UPDATE judgments SET status = 'complete', result_json = ?, latency_ms = ?, source = ?, cost_usd = ?, error = NULL WHERE id = ?`,
  )
    .bind(JSON.stringify(result), result.latencyMs, result.source, costUsd, id)
    .run();
}

export async function failJudgment(env: Env, id: string, message: string): Promise<void> {
  await env.DB.prepare(`UPDATE judgments SET status = 'error', error = ? WHERE id = ?`).bind(message.slice(0, 300), id).run();
}

export async function getJudgment(env: Env, id: string, now: number): Promise<JudgmentRow | null> {
  return env.DB.prepare(`SELECT ${JUDGMENT_COLUMNS} FROM judgments WHERE id = ? AND expires_at > ?`).bind(id, now).first<JudgmentRow>();
}

export async function listJudgments(env: Env, visitorId: string, now: number): Promise<JudgmentRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${JUDGMENT_COLUMNS} FROM judgments WHERE visitor_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(visitorId, now, LIMITS.historyLimit)
    .all<JudgmentRow>();
  return result.results ?? [];
}

export function mediaKey(id: string): string {
  return `media/${id}`;
}

function parseQuestions(raw: string): ChoiceQuestion[] {
  try {
    const parsed = JSON.parse(raw) as ChoiceQuestion[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseResult(raw: string, status: JudgmentRow["status"]): JudgmentResult | null {
  if (status !== "complete") return null;
  try {
    const parsed = JSON.parse(raw) as JudgmentResult;
    if (!parsed || !Array.isArray(parsed.answers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function toView(row: JudgmentRow): JudgmentView {
  return {
    id: row.id,
    pairId: row.pair_id,
    kind: row.kind,
    modality: row.modality,
    label: row.label,
    sampleId: row.sample_id,
    mediaId: row.media_id,
    status: row.status,
    error: row.error,
    questions: parseQuestions(row.questions_json),
    result: parseResult(row.result_json, row.status),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function cleanupExpired(env: Env, now: number): Promise<{ media: number; judgments: number }> {
  let media = 0;
  let judgments = 0;
  for (let batch = 0; batch < 5; batch++) {
    const rows = await env.DB.prepare(`SELECT id, r2_key FROM media WHERE expires_at <= ? ORDER BY expires_at LIMIT 40`).bind(now).all<{ id: string; r2_key: string }>();
    const found = rows.results ?? [];
    if (found.length === 0) break;
    for (const row of found) {
      try {
        await env.BUCKET.delete(row.r2_key);
      } catch (err) {
        console.error(JSON.stringify({ event: "cleanup_object_failed", error: String(err).slice(0, 200) }));
        continue;
      }
      await env.DB.prepare(`DELETE FROM media WHERE id = ?`).bind(row.id).run();
      media += 1;
    }
    if (found.length < 40) break;
  }
  const deleted = await env.DB.prepare(`DELETE FROM judgments WHERE expires_at <= ?`).bind(now).run();
  judgments = deleted.meta?.changes ?? 0;
  return { media, judgments };
}
