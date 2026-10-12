import { LIMITS, STEP_NAMES, type StepName } from "../shared/limits";
import type { BrowserMode, CaptureStatus, CaptureStep, CaptureView, SummarySource } from "../shared/types";

export type CaptureRow = {
  id: string;
  visitor_id: string;
  url: string;
  final_url: string;
  title: string;
  status: CaptureStatus;
  steps_json: string;
  error: string | null;
  browser_mode: BrowserMode;
  session_id: string;
  session_note: string;
  summary_source: SummarySource;
  ip_key: string;
  ip48_key: string;
  has_desktop: number;
  has_phone: number;
  has_pdf: number;
  has_markdown: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

const COLUMNS = `id, visitor_id, url, final_url, title, status, steps_json, error, browser_mode, session_id, session_note, summary_source, ip_key, ip48_key, has_desktop, has_phone, has_pdf, has_markdown, created_at, updated_at, expires_at`;

export function freshSteps(): CaptureStep[] {
  return STEP_NAMES.map((name) => ({ name, status: "pending", at: null }));
}

export function parseSteps(raw: string): CaptureStep[] {
  try {
    const parsed = JSON.parse(raw) as CaptureStep[];
    if (!Array.isArray(parsed)) return freshSteps();
    return parsed;
  } catch {
    return freshSteps();
  }
}

async function countWhere(env: Env, sql: string, ...binds: (string | number)[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function countRecent(env: Env, visitorId: string, since: number): Promise<number> {
  return countWhere(env, `SELECT COUNT(*) AS n FROM captures WHERE visitor_id = ? AND created_at >= ?`, visitorId, since);
}

export async function countRecentIp(env: Env, ipKey: string, since: number): Promise<number> {
  return countWhere(env, `SELECT COUNT(*) AS n FROM captures WHERE ip_key = ? AND created_at >= ?`, ipKey, since);
}

export async function countRecentIp48(env: Env, ip48Key: string, since: number): Promise<number> {
  return countWhere(env, `SELECT COUNT(*) AS n FROM captures WHERE ip48_key = ? AND created_at >= ?`, ip48Key, since);
}

export async function countSince(env: Env, since: number): Promise<number> {
  return countWhere(env, `SELECT COUNT(*) AS n FROM captures WHERE created_at >= ?`, since);
}

export async function insertCapture(env: Env, row: { id: string; visitorId: string; ipKey: string; ip48Key: string; url: string; now: number }): Promise<boolean> {
  const sinceHour = row.now - 60 * 60 * 1000;
  const sinceDay = row.now - LIMITS.retentionMs;
  const result = await env.DB.prepare(
    `INSERT INTO captures (id, visitor_id, ip_key, ip48_key, url, status, steps_json, created_at, updated_at, expires_at)
     SELECT ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM captures WHERE visitor_id = ? AND created_at >= ?) < ?
       AND (SELECT COUNT(*) FROM captures WHERE ip_key = ? AND created_at >= ?) < ?
       AND (SELECT COUNT(*) FROM captures WHERE ip48_key = ? AND created_at >= ?) < ?
       AND (SELECT COUNT(*) FROM captures WHERE created_at >= ?) < ?`,
  )
    .bind(
      row.id,
      row.visitorId,
      row.ipKey,
      row.ip48Key,
      row.url,
      JSON.stringify(freshSteps()),
      row.now,
      row.now,
      row.now + LIMITS.retentionMs,
      row.visitorId,
      sinceHour,
      LIMITS.capturesPerHour,
      row.ipKey,
      sinceHour,
      LIMITS.capturesPerHour,
      row.ip48Key,
      sinceHour,
      LIMITS.network48PerHour,
      sinceDay,
      LIMITS.dailyCap,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function getCapture(env: Env, id: string): Promise<CaptureRow | null> {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM captures WHERE id = ?`).bind(id).first<CaptureRow>();
}

export async function listCaptures(env: Env, visitorId: string): Promise<CaptureRow[]> {
  const result = await env.DB.prepare(`SELECT ${COLUMNS} FROM captures WHERE visitor_id = ? ORDER BY created_at DESC LIMIT 12`).bind(visitorId).all<CaptureRow>();
  return result.results ?? [];
}

type StepExtra = {
  status?: CaptureStatus;
  error?: string | null;
  finalUrl?: string;
  title?: string;
  browserMode?: BrowserMode;
  sessionId?: string;
  sessionNote?: string;
  summarySource?: SummarySource;
  hasDesktop?: boolean;
  hasPhone?: boolean;
  hasPdf?: boolean;
  hasMarkdown?: boolean;
};

async function writeSteps(env: Env, id: string, steps: CaptureStep[], extra: StepExtra): Promise<void> {
  const now = Date.now();
  const sessionId = extra.sessionId ? extra.sessionId.slice(0, 8) : "";
  await env.DB.prepare(
    `UPDATE captures
     SET steps_json = ?, updated_at = ?,
         status = COALESCE(?, status),
         error = CASE WHEN ? IS NULL THEN error ELSE ? END,
         final_url = CASE WHEN ? = '' THEN final_url ELSE ? END,
         title = CASE WHEN ? = '' THEN title ELSE ? END,
         browser_mode = CASE WHEN ? = '' THEN browser_mode ELSE ? END,
         session_id = CASE WHEN ? = '' THEN session_id ELSE ? END,
         session_note = CASE WHEN ? = '' THEN session_note ELSE ? END,
         summary_source = CASE WHEN ? = '' THEN summary_source ELSE ? END,
         has_desktop = CASE WHEN ? = 1 THEN 1 ELSE has_desktop END,
         has_phone = CASE WHEN ? = 1 THEN 1 ELSE has_phone END,
         has_pdf = CASE WHEN ? = 1 THEN 1 ELSE has_pdf END,
         has_markdown = CASE WHEN ? = 1 THEN 1 ELSE has_markdown END
     WHERE id = ?`,
  )
    .bind(
      JSON.stringify(steps),
      now,
      extra.status ?? null,
      extra.error === undefined ? null : extra.error,
      extra.error === undefined ? null : extra.error,
      extra.finalUrl ?? "",
      extra.finalUrl ?? "",
      extra.title ?? "",
      extra.title ?? "",
      extra.browserMode ?? "",
      extra.browserMode ?? "",
      sessionId,
      sessionId,
      extra.sessionNote ?? "",
      extra.sessionNote ?? "",
      extra.summarySource ?? "",
      extra.summarySource ?? "",
      extra.hasDesktop ? 1 : 0,
      extra.hasPhone ? 1 : 0,
      extra.hasPdf ? 1 : 0,
      extra.hasMarkdown ? 1 : 0,
      id,
    )
    .run();
}

export async function markStep(env: Env, id: string, name: StepName, status: CaptureStep["status"], extra: StepExtra & { captureStatus?: CaptureStatus } = {}): Promise<void> {
  const row = await getCapture(env, id);
  if (!row) return;
  const steps = parseSteps(row.steps_json).map((step) => (step.name === name ? { ...step, status, at: Date.now() } : step));
  const captureStatus = extra.captureStatus ?? (status === "error" ? "error" : status === "running" ? "running" : row.status);
  await writeSteps(env, id, steps, { ...extra, status: captureStatus });
}

export async function markError(env: Env, id: string, name: StepName | null, message: string): Promise<void> {
  const row = await getCapture(env, id);
  if (!row || row.status === "complete" || row.status === "error") return;
  const steps = parseSteps(row.steps_json).map((step) => {
    if (name && step.name === name) return { ...step, status: "error" as const, at: Date.now() };
    if (!name && step.status === "running") return { ...step, status: "error" as const, at: Date.now() };
    return step;
  });
  await writeSteps(env, id, steps, { status: "error", error: message.slice(0, 300) });
}

export async function markComplete(env: Env, id: string): Promise<void> {
  const row = await getCapture(env, id);
  if (!row) return;
  const steps = parseSteps(row.steps_json).map((step) => (step.status === "pending" || step.status === "running" ? { ...step, status: "done" as const, at: step.at ?? Date.now() } : step));
  await writeSteps(env, id, steps, { status: "complete", error: null });
}

export function prefix(id: string): string {
  return `captures/${id}/`;
}

export function objectKey(id: string, name: "desktop.png" | "desktop.jpg" | "phone.png" | "phone.jpg" | "page.pdf" | "page.md" | "summary.txt"): string {
  return `${prefix(id)}${name}`;
}

export async function listExpiredIds(env: Env, now: number): Promise<string[]> {
  const result = await env.DB.prepare(`SELECT id FROM captures WHERE expires_at <= ? ORDER BY expires_at LIMIT 40`).bind(now).all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}

export async function deleteCaptureRow(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM captures WHERE id = ?`).bind(id).run();
}

export async function toView(env: Env, row: CaptureRow): Promise<CaptureView> {
  let summary: string | null = null;
  let markdown: string | null = null;
  if (row.status === "complete") {
    const [summaryObject, markdownObject] = await Promise.all([
      env.BUCKET.get(objectKey(row.id, "summary.txt")),
      env.BUCKET.get(objectKey(row.id, "page.md")),
    ]);
    summary = summaryObject ? await summaryObject.text() : null;
    markdown = markdownObject ? await markdownObject.text() : null;
  }
  return {
    id: row.id,
    url: row.url,
    finalUrl: row.final_url,
    title: row.title,
    status: row.status,
    steps: parseSteps(row.steps_json),
    error: row.error,
    browserMode: row.browser_mode,
    sessionId: row.session_id.slice(0, 8),
    sessionNote: row.session_note,
    summarySource: row.summary_source,
    summary,
    markdown,
    hasDesktop: row.has_desktop === 1,
    hasPhone: row.has_phone === 1,
    hasPdf: row.has_pdf === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
