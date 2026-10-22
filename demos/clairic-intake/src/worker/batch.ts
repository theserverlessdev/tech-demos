import { bundledInbox } from "../shared/samples";
import { PRESETS } from "../shared/presets";
import { validateFields } from "../shared/schema";
import type { Answer } from "../shared/types";
import { claimInbox, failInbox, failInboxIds, getInbox, inboxInsert, releaseInbox, reserveCalls, saveInboxResult } from "./db";
import { runClairic, useMock } from "./models";

const ERROR_TEXT: Record<string, string> = {
  bad_schema: "The field schema was not valid.",
  extract_failed: "The extraction did not finish.",
  queue_send_failed: "The inbox could not be queued.",
  daily_budget: "The shared budget for today is used up.",
  budget: "This network is out of paid calls for today.",
};

export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enqueueBundledInbox(env: Env, visitorId: string, ipKey: string, now: number): Promise<string[]> {
  const rows = bundledInbox().map((doc) => {
    const fields = validateFields(PRESETS[doc.preset].fields);
    if (!fields.ok) throw new Error("bad_schema");
    return {
      id: newId(),
      doc,
      fieldsJson: JSON.stringify(fields.fields),
    };
  });
  await env.DB.batch(
    rows.map((row) =>
      inboxInsert(env, {
        id: row.id,
        visitorId,
        ipKey,
        sampleId: row.doc.id,
        title: row.doc.title,
        state: row.doc.state,
        fieldsJson: row.fieldsJson,
        now,
      }),
    ),
  );
  const ids = rows.map((row) => row.id);
  if (useMock(env)) {
    for (const id of ids) await processInboxItem(env, id, now);
  }
  try {
    await env.INTAKE.sendBatch(ids.map((id) => ({ body: { id } })));
  } catch (err) {
    if (useMock(env)) return ids;
    await failInboxIds(env, ids, "queue_send_failed", now);
    throw err;
  }
  return ids;
}

export async function processInboxItem(env: Env, id: string, now: number, attempts = 1): Promise<"done" | "missing" | "retry" | "lease"> {
  const claimed = await claimInbox(env, id, now);
  if (!claimed) {
    const row = await getInbox(env, id);
    if (!row) return "missing";
    if (row.status === "running") return "lease";
    if (row.status === "queued") return "retry";
    return "done";
  }
  const row = await getInbox(env, id);
  if (!row) return "missing";
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.fields_json);
  } catch (err) {
    await releaseInbox(env, id, "bad_schema", now);
    throw err;
  }
  const fields = validateFields(parsed);
  if (!fields.ok) {
    await failInbox(env, id, "bad_schema", now);
    return "done";
  }
  if (attempts > 1) {
    const reserved = await reserveRetry(env, row.ip_key, now);
    if (reserved !== "ok") {
      await failInbox(env, id, reserved, now);
      return "done";
    }
  }
  try {
    const extraction = await runClairic(env, row.state, fields.fields, null, now);
    await saveInboxResult(env, id, JSON.stringify(extraction.answers), extraction.source, extraction.stateText, extraction.truncated, now);
    return "done";
  } catch (err) {
    console.warn(JSON.stringify({ event: "inbox_extract_failed", id, error: err instanceof Error ? err.message : "error" }));
    await releaseInbox(env, id, "extract_failed", now);
    throw err;
  }
}

async function reserveRetry(env: Env, ipKey: string, now: number): Promise<"ok" | "budget" | "daily_budget"> {
  const reserved = await reserveCalls(env.DB, ipKey, now, 1);
  if (reserved === "ok") return "ok";
  return reserved === "global" ? "daily_budget" : "budget";
}

/** One delivery plus max_retries 3. The fourth delivery is the last. */
export const MAX_QUEUE_ATTEMPTS = 4;
/** Longer than the 60s lease, so the next delivery can claim the row. */
export const LEASE_RETRY_DELAY_SECONDS = 65;

export type QueueOutcome = { action: "ack" } | { action: "retry"; delaySeconds?: number };

export async function handleQueueMessage(env: Env, body: unknown, attempts: number, now = Date.now()): Promise<QueueOutcome> {
  const id = body && typeof body === "object" && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
  if (!/^[a-f0-9]{32}$/.test(id)) return { action: "ack" };
  try {
    const outcome = await processInboxItem(env, id, now, attempts);
    if (outcome === "lease" || outcome === "retry") return retryOrFail(env, id, outcome, attempts, now);
    return { action: "ack" };
  } catch (err) {
    console.warn(JSON.stringify({ event: "intake_retry", id, attempts, error: err instanceof Error ? err.message : "error" }));
    return retryOrFail(env, id, "retry", attempts, now);
  }
}

async function retryOrFail(env: Env, id: string, outcome: "lease" | "retry", attempts: number, now: number): Promise<QueueOutcome> {
  if (attempts >= MAX_QUEUE_ATTEMPTS) {
    await failInbox(env, id, "extract_failed", now);
    return { action: "ack" };
  }
  if (outcome === "lease") return { action: "retry", delaySeconds: LEASE_RETRY_DELAY_SECONDS };
  return { action: "retry" };
}

export function publicInbox(row: {
  id: string;
  sample_id: string;
  title: string;
  status: string;
  state: string;
  state_text?: string | null;
  truncated?: number;
  fields_json: string;
  answers_json: string | null;
  corrections_json: string | null;
  source: string | null;
  error: string | null;
  updated_at: number;
}) {
  let answers: Record<string, Answer> | null = null;
  let corrections: Record<string, string> | null = null;
  let fields: unknown = null;
  try {
    answers = row.answers_json ? (JSON.parse(row.answers_json) as Record<string, Answer>) : null;
  } catch {
    answers = null;
  }
  try {
    corrections = row.corrections_json ? (JSON.parse(row.corrections_json) as Record<string, string>) : null;
  } catch {
    corrections = null;
  }
  try {
    fields = JSON.parse(row.fields_json);
  } catch {
    fields = null;
  }
  return {
    id: row.id,
    sampleId: row.sample_id,
    title: row.title,
    status: row.status,
    state: row.state_text?.trim() ? row.state_text : row.state,
    truncated: row.truncated === 1,
    fields,
    answers,
    corrections,
    source: row.source,
    error: row.error ? (ERROR_TEXT[row.error] ?? ERROR_TEXT.extract_failed) : null,
    updatedAt: row.updated_at,
  };
}
