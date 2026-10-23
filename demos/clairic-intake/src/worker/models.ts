import { CLEF_MODEL_ID, COMPARE_MODEL_ID, DECISIONS, LIMITS, type Decision } from "../shared/limits";
import { clairicUsd, clefUsd, llamaUsd, usageFromChars } from "../shared/cost";
import { reviewFlags } from "../shared/highlight";
import { DECISION_CRITERIA, decisionState, distributionConfidence } from "../shared/policy";
import { llmSchemaReport, parseModelJson } from "../shared/schema";
import { dayKey } from "../shared/budget";
import type { Answer, DeskDecision, Extraction, FieldSpec, Usage } from "../shared/types";
import type { ImagePayload } from "../shared/schema";
import { mockClairic, mockCompare, mockDecide } from "./mock";

export function useMock(env: { ENVIRONMENT: string }): boolean {
  return env.ENVIRONMENT === "local";
}

export async function runClairic(
  env: Env,
  state: string,
  fields: Record<string, FieldSpec>,
  image: ImagePayload | null,
  now: number,
): Promise<Omit<Extraction, "comparison">> {
  if (useMock(env)) return mockClairic(state, fields, !!image);
  const started = Date.now();
  // @cf/cloudflare/clairic is not in @cloudflare/workers-types yet, so the model id and body are unchecked.
  const body = await withTimeout(
    env.AI.run(env.CLAIRIC_MODEL as never, {
      model: "clairic",
      state,
      fields,
      reference_date: dayKey(now),
      options: { return_state_text: true },
      ...(image ? { images: [{ content_type: image.content_type, base64: toBase64(image.bytes) }] } : {}),
    } as never),
    20_000,
    "clairic_timeout",
  );
  const root = unwrap(body);
  if (!root || !root.answers || typeof root.answers !== "object") throw new Error("clairic_unparsed");
  const answers: Record<string, Answer> = {};
  const rawAnswers = root.answers as Record<string, unknown>;
  for (const [name, spec] of Object.entries(fields)) answers[name] = asAnswer(rawAnswers[name], spec);
  const usage = readUsage(root, state, fields);
  const stateText = typeof root.state_text === "string" && root.state_text ? root.state_text : state;
  return {
    source: "clairic",
    model: env.CLAIRIC_MODEL,
    stateText,
    answers,
    usage,
    latencyMs: Date.now() - started,
    costUsd: clairicUsd(usage.input_tokens),
    review: reviewFlags(answers),
    photoUnread: false,
    truncated: root.truncated === true,
  };
}

export async function runCompare(env: Env, state: string, fields: Record<string, FieldSpec>): Promise<NonNullable<Extraction["comparison"]>> {
  if (useMock(env)) return mockCompare(state, fields);
  const started = Date.now();
  const prompt = [
    "Extract these fields from the document. Return one JSON object and nothing else.",
    "Use JSON null when the document does not say the value.",
    "Numbers must be numbers. Dates must be YYYY-MM-DD. Lists must be arrays.",
    `Fields:\n${JSON.stringify(fields)}`,
    `Document:\n${state}`,
  ].join("\n\n");
  try {
    // response_format is missing from this model's workers-types input. JSON mode may return response as an object.
    const body = await withTimeout(
      env.AI.run(env.COMPARE_MODEL as never, {
        messages: [
          { role: "system", content: "You extract JSON. No markdown." },
          { role: "user", content: prompt },
        ],
        max_tokens: 700,
        response_format: { type: "json_object" },
      } as never),
      25_000,
      "compare_timeout",
    );
    const root = unwrap(body) ?? {};
    const raw = textFromModel(root);
    let parsed: unknown = null;
    let reasons = ["Response is not a JSON object."];
    try {
      parsed = parseModelJson(raw);
      reasons = llmSchemaReport(fields, parsed).reasons;
    } catch {
      parsed = null;
    }
    const usage = readUsage(root, prompt, fields);
    if (!usage.output_tokens) usage.output_tokens = Math.max(1, Math.ceil(raw.length / 4));
    return {
      source: "llama",
      model: env.COMPARE_MODEL || COMPARE_MODEL_ID,
      latencyMs: Date.now() - started,
      costUsd: llamaUsd(usage.input_tokens, usage.output_tokens),
      schemaValid: reasons.length === 0,
      reasons,
      parsed,
      rawPreview: raw.slice(0, 500),
      usage,
    };
  } catch (err) {
    const code = err instanceof Error ? err.message : "compare_failed";
    const safe = code.replace(/[^a-z0-9_:-]/gi, "").slice(0, 40) || "compare_failed";
    const usage = usageFromChars(prompt.length, JSON.stringify(fields).length);
    return {
      source: "llama",
      model: env.COMPARE_MODEL || COMPARE_MODEL_ID,
      latencyMs: Date.now() - started,
      costUsd: null,
      schemaValid: false,
      reasons: [`llama_failed: ${safe}`],
      parsed: null,
      rawPreview: "",
      usage,
    };
  }
}

export async function runDecide(env: Env, answers: Record<string, Answer>): Promise<DeskDecision> {
  if (useMock(env)) return mockDecide(answers);
  const started = Date.now();
  const state = decisionState(answers);
  // @cf/cloudflare/clef is not in @cloudflare/workers-types yet, so the model id and body are unchecked.
  const body = await withTimeout(
    env.AI.run(env.CLEF_MODEL as never, {
      model: "clef",
      state,
      questions: {
        resolution: {
          type: "choice",
          instructions: "What should the intake desk do with this document?",
          criteria: DECISION_CRITERIA,
        },
      },
    } as never),
    12_000,
    "clef_timeout",
  );
  const parsed = parseClef(body);
  if (!parsed) throw new Error("clef_unparsed");
  const usage = readUsage(unwrap(body) ?? {}, state, DECISION_CRITERIA);
  return {
    source: "clef",
    model: env.CLEF_MODEL || CLEF_MODEL_ID,
    choice: parsed.choice,
    probabilities: parsed.probabilities,
    confidence: parsed.confidence,
    reason: `${DECISION_CRITERIA[parsed.choice]} Top probability ${parsed.probabilities[parsed.choice].toFixed(2)}.`,
    latencyMs: Date.now() - started,
    costUsd: clefUsd(usage.input_tokens),
  };
}

function parseClef(body: unknown): { choice: Decision; probabilities: Record<Decision, number>; confidence: number } | null {
  const root = unwrap(body);
  if (!root || !root.answers || typeof root.answers !== "object") return null;
  const resolution = (root.answers as Record<string, unknown>).resolution;
  if (!resolution || typeof resolution !== "object") return null;
  const raw = (resolution as { probabilities?: unknown }).probabilities;
  if (!raw || typeof raw !== "object") return null;
  const probabilities = {} as Record<Decision, number>;
  let sum = 0;
  for (const key of DECISIONS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
    probabilities[key] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > 0.2) return null;
  let choice: Decision = "escalate";
  let best = -1;
  for (const key of DECISIONS) {
    if (probabilities[key] > best) {
      best = probabilities[key];
      choice = key;
    }
  }
  const reported = (resolution as { choice?: unknown }).choice;
  if (reported === "refund" || reported === "escalate" || reported === "approve") choice = reported;
  const confidenceValue = (resolution as { confidence?: unknown }).confidence;
  const confidence = typeof confidenceValue === "number" ? confidenceValue : distributionConfidence(probabilities);
  if (confidence < LIMITS.clefFloor && choice === "approve") choice = "escalate";
  return { choice, probabilities, confidence };
}

function asAnswer(raw: unknown, spec: FieldSpec): Answer {
  if (!raw || typeof raw !== "object") return { type: spec.type, value: null, p_null: 1, confidence: 0 };
  const record = raw as Record<string, unknown>;
  const answer: Answer = {
    type: typeof record.type === "string" ? record.type : spec.type,
    value: Object.hasOwn(record, "value") ? record.value : null,
  };
  copyNumber(answer, "p_null", record.p_null);
  copyNumber(answer, "confidence", record.confidence);
  copyNumber(answer, "mean", record.mean);
  copyNumber(answer, "p_below", record.p_below);
  copyNumber(answer, "p_above", record.p_above);
  if (typeof record.guess !== "undefined") answer.guess = record.guess;
  if (typeof record.unit === "string") answer.unit = record.unit;
  const span = pair(record.span);
  if (span) answer.span = span;
  if (Array.isArray(record.spans)) {
    const spans = record.spans.flatMap((item) => {
      const next = pair(item);
      return next ? [next] : [];
    });
    if (spans.length) answer.spans = spans;
  }
  if (typeof record.median === "number" || Array.isArray(record.median)) answer.median = record.median as number | number[];
  if (typeof record.p10 === "number" || Array.isArray(record.p10)) answer.p10 = record.p10 as number | number[];
  if (typeof record.p90 === "number" || Array.isArray(record.p90)) answer.p90 = record.p90 as number | number[];
  if (Array.isArray(record.steps)) answer.steps = record.steps as Answer[];
  return answer;
}

function copyNumber(answer: Answer, key: "p_null" | "confidence" | "mean" | "p_below" | "p_above", value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) answer[key] = value;
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

function readUsage(root: Record<string, unknown>, state: string, schema: unknown): Usage {
  const usage = root.usage && typeof root.usage === "object" ? (root.usage as Record<string, unknown>) : {};
  const input = numberOr(usage.input_tokens, numberOr(usage.prompt_tokens, 0));
  const output = numberOr(usage.output_tokens, numberOr(usage.completion_tokens, 0));
  const fallback = usageFromChars(state.length, JSON.stringify(schema).length);
  return {
    state_tokens: numberOr(usage.state_tokens, fallback.state_tokens),
    image_tokens: numberOr(usage.image_tokens, 0),
    schema_tokens: numberOr(usage.schema_tokens, fallback.schema_tokens),
    input_tokens: input || fallback.input_tokens,
    output_tokens: output,
    passes: numberOr(usage.passes, 1),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function unwrap(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.success === false) return null;
  if (record.result && typeof record.result === "object") return record.result as Record<string, unknown>;
  return record;
}

function textFromModel(root: Record<string, unknown>): string {
  if (typeof root.response === "string") return root.response;
  if (root.response && typeof root.response === "object") return JSON.stringify(root.response);
  const choices = root.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const message = (choices[0] as { message?: { content?: unknown } }).message;
    if (typeof message?.content === "string") return message.content;
  }
  throw new Error("compare_empty");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function withTimeout<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(code));
      },
    );
  });
}
