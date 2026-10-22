import { bundledInbox } from "../shared/samples";
import { PRESETS } from "../shared/presets";
import { validateFields } from "../shared/schema";
import type { Answer } from "../shared/types";
import { claimInbox, failInbox, getInbox, insertInbox, releaseInbox, saveInboxResult } from "./db";
import { runClairic, useMock } from "./models";

export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enqueueBundledInbox(env: Env, visitorId: string, ipKey: string, now: number): Promise<string[]> {
  const ids: string[] = [];
  for (const doc of bundledInbox()) {
    const fields = validateFields(PRESETS[doc.preset].fields);
    if (!fields.ok) throw new Error(fields.message);
    const id = newId();
    await insertInbox(env, {
      id,
      visitorId,
      ipKey,
      sampleId: doc.id,
      title: doc.title,
      state: doc.state,
      fieldsJson: JSON.stringify(fields.fields),
      now,
    });
    ids.push(id);
    if (useMock(env)) await processInboxItem(env, id, now);
    try {
      await env.INTAKE.send({ id });
    } catch (err) {
      if (useMock(env)) continue;
      await failInbox(env, id, "queue_send_failed", now);
      throw err;
    }
  }
  return ids;
}

export async function processInboxItem(env: Env, id: string, now: number): Promise<"done" | "missing" | "busy"> {
  const claimed = await claimInbox(env, id, now);
  if (!claimed) {
    const row = await getInbox(env, id);
    if (!row) return "missing";
    return row.status === "queued" ? "busy" : "done";
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
    await failInbox(env, id, fields.message, now);
    return "done";
  }
  try {
    const extraction = await runClairic(env, row.state, fields.fields, null, now);
    await saveInboxResult(env, id, JSON.stringify(extraction.answers), extraction.source, now);
    return "done";
  } catch (err) {
    await releaseInbox(env, id, err instanceof Error ? err.message : "extract_failed", now);
    throw err;
  }
}

export async function handleQueueMessage(env: Env, body: unknown, attempts: number, now = Date.now()): Promise<"ack" | "retry"> {
  const id = body && typeof body === "object" && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
  if (!/^[a-f0-9]{32}$/.test(id)) return "ack";
  try {
    await processInboxItem(env, id, now);
    return "ack";
  } catch (err) {
    console.warn(JSON.stringify({ event: "intake_retry", id, attempts, error: err instanceof Error ? err.message : "error" }));
    if (attempts >= 3) {
      await failInbox(env, id, "The extraction did not finish.", now);
      return "ack";
    }
    return "retry";
  }
}

export function publicInbox(row: {
  id: string;
  sample_id: string;
  title: string;
  status: string;
  state: string;
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
    state: row.state,
    fields,
    answers,
    corrections,
    source: row.source,
    error: row.error,
    updatedAt: row.updated_at,
  };
}
