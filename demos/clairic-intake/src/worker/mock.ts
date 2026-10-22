import { COMPARE_MODEL_ID, MOCK_LATENCY_MS } from "../shared/limits";
import { clairicUsd, clefUsd, llamaUsd, usageFromChars } from "../shared/cost";
import { llmSchemaReport, parseModelJson } from "../shared/schema";
import { reviewFlags } from "../shared/highlight";
import { chooseFromAnswers, DECISION_CRITERIA, distributionConfidence, probabilitiesFor } from "../shared/policy";
import type { Answer, Comparison, DeskDecision, Extraction, FieldSpec } from "../shared/types";

const PHRASES = ["cracked screen", "dented corner", "broken hinge", "water leak", "vehicle damage", "sprained wrist"];

export function mockClairic(state: string, fields: Record<string, FieldSpec>, hasImage: boolean): Omit<Extraction, "comparison"> {
  const photoUnread = hasImage && state.trim().length === 0;
  const answers: Record<string, Answer> = {};
  for (const [name, spec] of Object.entries(fields)) {
    answers[name] = photoUnread ? unread(spec) : mockField(state, name, spec);
  }
  const schemaChars = JSON.stringify(fields).length;
  const usage = usageFromChars(state.length, schemaChars);
  return {
    source: "mock",
    model: "@cf/cloudflare/clairic",
    stateText: state,
    answers,
    usage,
    latencyMs: MOCK_LATENCY_MS.clairic,
    costUsd: clairicUsd(usage.input_tokens),
    review: reviewFlags(answers),
    photoUnread,
  };
}

export function mockCompare(state: string, fields: Record<string, FieldSpec>): Comparison {
  const rough: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(fields)) {
    const answer = mockField(state, name, spec);
    rough[name] = distort(spec, answer);
  }
  const raw = "```json\n" + JSON.stringify(rough, null, 2) + "\n```";
  let parsed: unknown = null;
  let reasons = ["Response is not a JSON object."];
  try {
    parsed = parseModelJson(raw);
    reasons = llmSchemaReport(fields, parsed).reasons;
  } catch {
    parsed = null;
  }
  const usage = usageFromChars(state.length + 200, JSON.stringify(fields).length, raw.length);
  return {
    source: "mock",
    model: COMPARE_MODEL_ID,
    latencyMs: MOCK_LATENCY_MS.llama,
    costUsd: llamaUsd(usage.input_tokens, usage.output_tokens),
    schemaValid: reasons.length === 0,
    reasons,
    parsed,
    rawPreview: raw.slice(0, 500),
    usage,
  };
}

export function mockDecide(answers: Record<string, Answer>): DeskDecision {
  const choice = chooseFromAnswers(answers);
  const probabilities = probabilitiesFor(choice);
  const usage = usageFromChars(400, 200);
  return {
    source: "mock",
    model: "@cf/cloudflare/clef",
    choice,
    probabilities,
    confidence: distributionConfidence(probabilities),
    reason: `${DECISION_CRITERIA[choice]} Top probability ${probabilities[choice].toFixed(2)}.`,
    latencyMs: MOCK_LATENCY_MS.clef,
    costUsd: clefUsd(usage.input_tokens),
  };
}

function distort(spec: FieldSpec, answer: Answer): unknown {
  if (answer.value === null || answer.value === undefined) {
    if (spec.type === "text") return "PO-00000";
    if (spec.type === "list") return "";
    return "unknown";
  }
  if (spec.type === "number" || spec.type === "duration" || spec.type === "estimate") return `$${answer.value}`;
  if (spec.type === "date") return "Sept 2";
  if (spec.type === "list" && Array.isArray(answer.value)) return answer.value.join(", ");
  if (spec.type === "forecast") return "higher next week";
  return answer.value;
}

function unread(spec: FieldSpec): Answer {
  return { type: spec.type, value: spec.type === "list" ? [] : null, p_null: 1, confidence: 0.2, guess: null };
}

function mockField(state: string, name: string, spec: FieldSpec): Answer {
  switch (spec.type) {
    case "text":
      return textField(state, name, spec);
    case "number":
      return numberField(state, name, spec);
    case "date":
      return dateField(state, name, spec);
    case "time":
      return timeField(state, spec);
    case "datetime":
      return datetimeField(state, spec);
    case "duration":
      return durationField(state, spec);
    case "list":
      return listField(state, name, spec);
    case "estimate":
      return estimateField(state, name, spec);
    case "forecast":
      return forecastField(state, spec);
    default:
      return { type: spec.type, value: null, p_null: 1, confidence: 0 };
  }
}

function textField(state: string, name: string, spec: FieldSpec): Answer {
  const key = name.toLowerCase();
  if (key.includes("police") && /no police/i.test(state)) return missing(spec, null);
  if (key.includes("tracking") || key === "po_number" || key.includes("police")) {
    const label = key.includes("police") ? "PR" : key.includes("tracking") ? "TRK" : "PO";
    const found = matchOne(state, new RegExp(`\\b${label}-[A-Z0-9-]+\\b`));
    return found ? hit(spec, found.value, found.span, 0.99) : missing(spec, null);
  }
  if (key.includes("invoice") || key.includes("policy") || key.includes("order")) {
    const patterns = key.includes("policy")
      ? [/\bPOL-[A-Z0-9-]+\b/]
      : key.includes("invoice")
        ? [/\bINV-[A-Z0-9-]+\b/, /\bOrder\s+\d+\b/i]
        : [/\b[A-Z]-\d+\b/, /\bOrder\s+\d+\b/i, /\bINV-[A-Z0-9-]+\b/];
    for (const pattern of patterns) {
      const found = matchOne(state, pattern);
      if (found) return hit(spec, found.value, found.span, 0.99);
    }
    return missing(spec, null);
  }
  if (key.includes("vendor") || key.includes("claimant") || key.includes("customer") || key.includes("name")) {
    const labelled = matchOne(state, /(?:Claimant|Thanks):\s*([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)/);
    const from = key.includes("vendor") ? matchOne(state, /\bfrom\s+([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)/) : null;
    const thanks = matchOne(state, /Thanks,\s*([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)/);
    const picked = key.includes("vendor") ? from ?? labelled : thanks ?? labelled;
    if (picked) return hit(spec, picked.value, picked.span, 0.97);
    const first = state.split("\n")[0]?.trim() ?? "";
    if (key.includes("vendor") && /^[A-Z][A-Z ]{2,}$/.test(first)) {
      const span = locate(state, first);
      if (span) return hit(spec, first, span, 0.72);
    }
    return missing(spec, null);
  }
  return missing(spec, null);
}

function numberField(state: string, name: string, spec: FieldSpec): Answer {
  const key = name.toLowerCase();
  if (key.includes("total") || key === "amount_paid" || key.includes("loss") || key.includes("paid")) {
    const totalLine = matchOne(state, /\bTotal\s+\$([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i);
    if (key.includes("total") && totalLine) {
      const parsed = moneyNumber(totalLine.value);
      return hit(spec, parsed, totalLine.span, 0.98);
    }
    const pallets = palletTotal(state);
    if (pallets !== null && (key.includes("total") || key.includes("paid") || key.includes("loss"))) {
      return hit(spec, pallets, undefined, 0.97);
    }
    const amounts = moneyAll(state);
    if (amounts.length) {
      const sum = round2(amounts.reduce((acc, item) => acc + item.value, 0));
      return hit(spec, key.includes("loss") ? amounts[amounts.length - 1].value : sum, undefined, 0.96);
    }
    return missing(spec, 0);
  }
  const amounts = moneyAll(state);
  if (!amounts.length) return missing(spec, 0);
  return hit(spec, amounts[0].value, [amounts[0].start, amounts[0].end], 0.9);
}

function dateField(state: string, name: string, spec: FieldSpec): Answer {
  const dates = isoDates(state);
  if (!dates.length) return missing(spec, null);
  if (name === "due_date") {
    const net = state.match(/\bnet\s+(\d{1,3})\b/i);
    if (!net) return missing(spec, null);
    const due = addDays(dates[0].value, Number(net[1]));
    return hit(spec, due, undefined, 0.95);
  }
  return hit(spec, dates[0].value, dates[0].span, 0.99);
}

function timeField(state: string, spec: FieldSpec): Answer {
  const found = matchOne(state, /\b(\d{2}:\d{2})(?::\d{2})?\b/);
  return found ? hit(spec, found.value, found.span, 0.9) : missing(spec, null);
}

function datetimeField(state: string, spec: FieldSpec): Answer {
  const dates = isoDates(state);
  if (!dates.length) return missing(spec, null);
  const time = matchOne(state, /\b(\d{2}:\d{2})(?::\d{2})?\b/);
  const clock = time ? time.value.slice(0, 5) : "00:00";
  return hit(spec, `${dates[0].value}T${clock}:00`, dates[0].span, 0.9);
}

function durationField(state: string, spec: FieldSpec): Answer {
  const dates = isoDates(state);
  if (dates.length < 2) return missing(spec, null);
  const days = Math.abs(daysBetween(dates[0].value, dates[dates.length - 1].value));
  return { ...hit(spec, days, undefined, 0.98), unit: spec.unit ?? "days" };
}

function listField(state: string, name: string, spec: FieldSpec): Answer {
  if (name === "contacts" || spec.instructions?.toLowerCase().includes("contact")) {
    const block = state.match(/Contact:\s*([^.]+)/);
    if (!block || block.index === undefined) return { type: "list", value: [], spans: [], confidence: 0.9 };
    const names = block[1].split(",").map((part) => part.trim()).filter(Boolean);
    const spans = names.flatMap((item) => {
      const span = locate(state, item);
      return span ? [span] : [];
    });
    return { type: "list", value: names, spans, confidence: names.length ? 0.99 : 0.7 };
  }
  const found = PHRASES.flatMap((phrase) => {
    const span = locateFold(state, phrase);
    return span ? [{ phrase: state.slice(span[0], span[1]), span }] : [];
  });
  return {
    type: "list",
    value: found.map((item) => item.phrase),
    spans: found.map((item) => item.span),
    confidence: found.length ? 0.98 : 0.86,
  };
}

function estimateField(state: string, name: string, spec: FieldSpec): Answer {
  const min = typeof spec.min === "number" ? spec.min : 0;
  const max = typeof spec.max === "number" ? spec.max : min + 1;
  let median = (min + max) / 2;
  if (name === "days_to_pay") {
    const net = state.match(/\bnet\s+(\d{1,3})\b/i);
    median = net ? Number(net[1]) : 30;
  } else if (name === "repair_cost") {
    const base = sumMoney(state);
    median = base > 0 ? round2(base * 0.35) : 80;
  } else if (name === "reserve") {
    const amounts = moneyAll(state);
    median = amounts.length ? amounts[amounts.length - 1].value : 1000;
  }
  median = clamp(median, min, max);
  const p10 = clamp(round2(median * 0.7), min, max);
  const p90 = clamp(round2(median * 1.25), min, max);
  return {
    type: "estimate",
    value: median,
    mean: median,
    median,
    p10,
    p90,
    p_below: 0,
    p_above: 0,
    unit: spec.unit,
  };
}

function forecastField(state: string, spec: FieldSpec): Answer {
  const min = typeof spec.min === "number" ? spec.min : 0;
  const max = typeof spec.max === "number" ? spec.max : min + 1;
  const horizon = spec.horizon ?? 4;
  const history = historyNumbers(state);
  const last = history.length ? history[history.length - 1] : (min + max) / 5;
  const median: number[] = [];
  const p10: number[] = [];
  const p90: number[] = [];
  for (let step = 1; step <= horizon; step++) {
    const point = clamp(round2(last * Math.pow(0.97, step)), min, max);
    median.push(point);
    p10.push(clamp(round2(point * 0.9), min, max));
    p90.push(clamp(round2(point * 1.1), min, max));
  }
  return { type: "forecast", value: median, median, p10, p90, unit: spec.unit };
}

function hit(spec: FieldSpec, value: unknown, span: [number, number] | undefined, confidence: number): Answer {
  return {
    type: spec.type,
    value,
    guess: value,
    p_null: 0.001,
    confidence,
    ...(span ? { span } : {}),
    ...(spec.unit ? { unit: spec.unit } : {}),
  };
}

function missing(spec: FieldSpec, guess: unknown): Answer {
  return { type: spec.type, value: null, guess, p_null: 0.99, confidence: 0.42, ...(spec.unit ? { unit: spec.unit } : {}) };
}

function matchOne(state: string, pattern: RegExp): { value: string; span: [number, number]; spanText: string } | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const found = re.exec(state);
  if (!found || found.index === undefined) return null;
  const text = found[1] && found[0].includes(found[1]) ? found[1] : found[0];
  const offset = found[0].indexOf(text);
  const start = found.index + (offset < 0 ? 0 : offset);
  return { value: text, span: [start, start + text.length], spanText: found[0] };
}

function locate(state: string, value: string): [number, number] | undefined {
  const at = state.indexOf(value);
  if (at < 0) return undefined;
  return [at, at + value.length];
}

function locateFold(state: string, phrase: string): [number, number] | undefined {
  const at = state.toLowerCase().indexOf(phrase.toLowerCase());
  if (at < 0) return undefined;
  return [at, at + phrase.length];
}

function moneyAll(state: string): { value: number; start: number; end: number }[] {
  const re = /\$([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g;
  const out: { value: number; start: number; end: number }[] = [];
  for (const found of state.matchAll(re)) {
    if (found.index === undefined) continue;
    out.push({ value: Number(found[1].replace(/,/g, "")), start: found.index, end: found.index + found[0].length });
  }
  return out;
}

function moneyNumber(raw: string): number {
  const found = raw.replace(/[^0-9.]/g, "");
  return Number(found);
}

function sumMoney(state: string): number {
  return moneyAll(state).reduce((acc, item) => acc + item.value, 0);
}

function palletTotal(state: string): number | null {
  const pallet = state.match(/(\d+)\s+(?:pallets?|crates?|drinks?)\s+at\s+\$([0-9]+(?:\.[0-9]{2})?)/i);
  if (!pallet) return null;
  const ship = state.match(/shipping\s+\$([0-9]+(?:\.[0-9]{2})?)/i);
  return round2(Number(pallet[1]) * Number(pallet[2]) + (ship ? Number(ship[1]) : 0));
}

function isoDates(state: string): { value: string; span: [number, number] }[] {
  const re = /\b(\d{4}-\d{2}-\d{2})\b/g;
  const out: { value: string; span: [number, number] }[] = [];
  for (const found of state.matchAll(re)) {
    if (found.index === undefined) continue;
    out.push({ value: found[1], span: [found.index, found.index + found[1].length] });
  }
  return out;
}

function historyNumbers(state: string): number[] {
  const out: number[] = [];
  for (const line of state.split("\n")) {
    const found = line.match(/^\d{4}-\d{2}-\d{2},\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (found) out.push(Number(found[1]));
  }
  return out;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
