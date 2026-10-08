import type { AuditRow, ClefModel, GateCard, GateDecision, GateSource, HumanOutcome, Probabilities } from "../shared/types";
import { GATE_DECISIONS } from "../shared/types";

const SESSION_CAP = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDecision(value: unknown): value is GateDecision {
  return value === "allow" || value === "deny" || value === "ask-human";
}

function isSource(value: unknown): value is GateSource {
  return value === "clef" || value === "local-heuristic" || value === "unavailable";
}

function isHuman(value: unknown): value is HumanOutcome {
  return value === "approve" || value === "deny" || value === "expired";
}

function parseProbabilities(raw: string): Probabilities | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    const out = { allow: 0, deny: 0, "ask-human": 0 } as Probabilities;
    for (const key of GATE_DECISIONS) {
      const n = value[key];
      if (typeof n !== "number" || !Number.isFinite(n)) return null;
      out[key] = n;
    }
    return out;
  } catch {
    return null;
  }
}

export async function insertSession(db: D1Database, id: string, model: ClefModel, createdAt: number, expiresAt: number): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, model, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model = excluded.model, expires_at = excluded.expires_at")
    .bind(id, model, createdAt, expiresAt)
    .run();
}

export async function insertDecision(db: D1Database, sessionId: string, card: GateCard): Promise<void> {
  await db
    .prepare(
      `INSERT INTO decisions
        (id, session_id, created_at, tool, args_summary, decision, probabilities, confidence, latency_ms, model, source, human_outcome, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      card.decisionId,
      sessionId,
      Date.now(),
      card.tool,
      card.argsSummary,
      card.decision,
      JSON.stringify(card.probabilities),
      card.confidence,
      card.latencyMs,
      card.model,
      card.source,
    )
    .run();

  await db
    .prepare(
      `DELETE FROM decisions WHERE session_id = ? AND id NOT IN (
         SELECT id FROM decisions WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
       )`,
    )
    .bind(sessionId, sessionId, SESSION_CAP)
    .run();
}

export async function setHumanOutcome(db: D1Database, sessionId: string, decisionId: string, outcome: HumanOutcome): Promise<boolean> {
  const result = await db
    .prepare("UPDATE decisions SET human_outcome = ?, resolved_at = ? WHERE id = ? AND session_id = ? AND human_outcome IS NULL")
    .bind(outcome, Date.now(), decisionId, sessionId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listDecisions(db: D1Database, sessionId: string): Promise<AuditRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, tool, args_summary, decision, probabilities, confidence, latency_ms, model, source, human_outcome, created_at
       FROM decisions WHERE session_id = ? ORDER BY created_at DESC LIMIT 40`,
    )
    .bind(sessionId)
    .all<Record<string, unknown>>();

  const rows: AuditRow[] = [];
  for (const row of results) {
    if (typeof row.id !== "string" || typeof row.tool !== "string" || typeof row.args_summary !== "string") continue;
    if (!isDecision(row.decision) || typeof row.probabilities !== "string") continue;
    const probabilities = parseProbabilities(row.probabilities);
    if (!probabilities || typeof row.confidence !== "number" || typeof row.latency_ms !== "number") continue;
    if (typeof row.model !== "string" || !isSource(row.source) || typeof row.created_at !== "number") continue;
    rows.push({
      id: row.id,
      tool: row.tool,
      argsSummary: row.args_summary,
      decision: row.decision,
      probabilities,
      confidence: row.confidence,
      latencyMs: row.latency_ms,
      model: row.model,
      source: row.source,
      humanOutcome: isHuman(row.human_outcome) ? row.human_outcome : null,
      createdAt: row.created_at,
    });
  }
  return rows;
}

export async function purgeExpired(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare("DELETE FROM decisions WHERE session_id IN (SELECT id FROM sessions WHERE expires_at < ?)").bind(now).run();
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  await db.prepare("DELETE FROM decisions WHERE created_at < ?").bind(now - 24 * 60 * 60 * 1000).run();
}

export async function purgeSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM decisions WHERE session_id = ?").bind(sessionId).run();
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}
