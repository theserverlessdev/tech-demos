import {
  DURATION_UNITS,
  FIELD_NAME,
  FIELD_TYPES,
  FORECAST_INTERVALS,
  LIMITS,
  type FieldType,
} from "./limits";
import type { FieldSpec } from "./types";
import { cleanText } from "./escape";

const SPEC_KEYS = new Set([
  "type",
  "instructions",
  "unit",
  "integer",
  "decimals",
  "items",
  "min",
  "max",
  "step",
  "scale",
  "null_threshold",
  "horizon",
  "interval",
]);

const RESERVED = new Set(["__proto__", "prototype", "constructor"]);

export type ImagePayload = {
  content_type: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
};

export function validateFields(input: unknown): { ok: true; fields: Record<string, FieldSpec> } | { ok: false; message: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "Fields must be an object." };
  }
  const entries = Object.entries(input).filter(([key]) => Object.hasOwn(input, key));
  if (entries.length < 1) return { ok: false, message: "Add at least one field." };
  if (entries.length > LIMITS.maxFields) return { ok: false, message: `Keep the schema to ${LIMITS.maxFields} fields.` };

  const fields: Record<string, FieldSpec> = {};
  for (const [name, raw] of entries) {
    if (RESERVED.has(name) || !FIELD_NAME.test(name)) {
      return { ok: false, message: `“${name.slice(0, 40)}” is not a valid field name.` };
    }
    const parsed = parseSpec(raw);
    if (!parsed.ok) return { ok: false, message: `${name}: ${parsed.message}` };
    fields[name] = parsed.spec;
  }
  return { ok: true, fields };
}

function parseSpec(raw: unknown): { ok: true; spec: FieldSpec } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "a field spec must be an object." };
  for (const key of Object.keys(raw)) {
    if (!SPEC_KEYS.has(key)) return { ok: false, message: `unknown setting “${key}”.` };
  }
  const record = raw as Record<string, unknown>;
  if (!FIELD_TYPES.includes(record.type as FieldType)) return { ok: false, message: "type must be one of the nine Clairic types." };
  const type = record.type as FieldType;
  const spec: FieldSpec = { type };

  if (record.instructions !== undefined) {
    if (typeof record.instructions !== "string") return { ok: false, message: "instructions must be text." };
    const instructions = record.instructions.trim();
    if (instructions.length > LIMITS.maxInstructions) return { ok: false, message: "instructions are too long." };
    if (instructions) spec.instructions = instructions;
  }
  if (record.unit !== undefined) {
    if (typeof record.unit !== "string") return { ok: false, message: "unit must be text." };
    const unit = record.unit.trim();
    if (unit.length > LIMITS.maxUnit) return { ok: false, message: "unit is too long." };
    if (type === "duration" && !DURATION_UNITS.includes(unit as (typeof DURATION_UNITS)[number])) {
      return { ok: false, message: "duration unit must be seconds, minutes, hours, days, weeks, months, or years." };
    }
    if (unit) spec.unit = unit;
  }
  if (record.integer !== undefined) {
    if (typeof record.integer !== "boolean") return { ok: false, message: "integer must be true or false." };
    if (record.integer && type !== "number" && type !== "duration") return { ok: false, message: "integer applies to number and duration fields." };
    if (record.integer) spec.integer = true;
  }
  if (record.decimals !== undefined) {
    if (typeof record.decimals !== "number" || !Number.isInteger(record.decimals) || record.decimals < 0 || record.decimals > 6) {
      return { ok: false, message: "decimals must be an integer from 0 to 6." };
    }
    const decimalsOk = type === "number" || type === "duration" || (type === "list" && record.items === "number");
    if (!decimalsOk) return { ok: false, message: "decimals applies to numbers, durations, and number lists." };
    spec.decimals = record.decimals;
  }
  if (type === "list") {
    if (record.items !== "text" && record.items !== "number" && record.items !== "date") {
      return { ok: false, message: "list items must be text, number, or date." };
    }
    spec.items = record.items;
  } else if (record.items !== undefined) {
    return { ok: false, message: "items applies to list fields." };
  }
  if (record.scale !== undefined) {
    if (record.scale !== "linear" && record.scale !== "log") return { ok: false, message: "scale must be linear or log." };
    if (type !== "estimate" && type !== "forecast") return { ok: false, message: "scale applies to estimate and forecast fields." };
    spec.scale = record.scale;
  }
  if (record.null_threshold !== undefined) {
    if (typeof record.null_threshold !== "number" || !(record.null_threshold > 0) || record.null_threshold > 1) {
      return { ok: false, message: "null_threshold must be above 0 and at most 1." };
    }
    spec.null_threshold = record.null_threshold;
  }
  if (type === "estimate" || type === "forecast") {
    const bounds = readBounds(record.min, record.max);
    if (!bounds.ok) return bounds;
    spec.min = bounds.min;
    spec.max = bounds.max;
  } else if (record.min !== undefined || record.max !== undefined) {
    return { ok: false, message: "min and max apply to estimate and forecast fields." };
  }
  if (record.step !== undefined) {
    if (type !== "estimate") return { ok: false, message: "step applies to estimate fields." };
    if (record.step === "month" || record.step === "year") spec.step = record.step;
    else if (typeof record.step === "number" && Number.isFinite(record.step) && record.step > 0) spec.step = record.step;
    else return { ok: false, message: "step must be a positive number, month, or year." };
  }
  if (type === "forecast") {
    if (typeof record.horizon !== "number" || !Number.isInteger(record.horizon) || record.horizon < 1 || record.horizon > LIMITS.maxHorizon) {
      return { ok: false, message: `horizon must be an integer from 1 to ${LIMITS.maxHorizon}.` };
    }
    if (typeof record.interval !== "string" || !FORECAST_INTERVALS.includes(record.interval as (typeof FORECAST_INTERVALS)[number])) {
      return { ok: false, message: "interval must be a forecast step size." };
    }
    spec.horizon = record.horizon;
    spec.interval = record.interval;
  } else if (record.horizon !== undefined || record.interval !== undefined) {
    return { ok: false, message: "horizon and interval apply to forecast fields." };
  }
  return { ok: true, spec };
}

function readBounds(min: unknown, max: unknown): { ok: true; min: number | string; max: number | string } | { ok: false; message: string } {
  if (typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && min < max) {
    return { ok: true, min, max };
  }
  if (typeof min === "string" && typeof max === "string" && isoDate(min) && isoDate(max) && min < max) {
    return { ok: true, min, max };
  }
  return { ok: false, message: "min and max are required, and min must be less than max." };
}

export function isoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function imageIsRemote(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^https?:/i.test(trimmed) || trimmed.startsWith("//");
}

export function validateImage(input: unknown): { ok: true; image: ImagePayload } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: false, message: "Missing image." };
  if (typeof input === "string") {
    if (imageIsRemote(input)) return { ok: false, message: "Images must be uploaded. This desk does not fetch URLs." };
    return { ok: false, message: "Send the image as content_type and base64." };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "Image payload is not an object." };
  const record = input as Record<string, unknown>;
  if (record.url !== undefined || imageIsRemote(record.base64) || imageIsRemote(record.content_type)) {
    return { ok: false, message: "Images must be uploaded. This desk does not fetch URLs." };
  }
  const contentType = record.content_type;
  if (contentType !== "image/png" && contentType !== "image/jpeg" && contentType !== "image/webp") {
    return { ok: false, message: "Use a PNG, JPEG, or WebP image." };
  }
  if (typeof record.base64 !== "string" || record.base64.length < 16) return { ok: false, message: "Image data is missing." };
  const bytes = decodeBase64(record.base64.replace(/\s/g, ""));
  if (!bytes) return { ok: false, message: "Image data is not valid base64." };
  if (bytes.byteLength > LIMITS.maxImageBytes) return { ok: false, message: "That image is over the 1.5 MB limit." };
  if (!sniff(bytes, contentType)) return { ok: false, message: "The file bytes do not match the declared image type." };
  return { ok: true, image: { content_type: contentType, bytes } };
}

function sniff(bytes: Uint8Array, type: ImagePayload["content_type"]): boolean {
  if (type === "image/png") return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (type === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function llmSchemaReport(fields: Record<string, FieldSpec>, parsed: unknown): { valid: boolean; reasons: string[] } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, reasons: ["Response is not a JSON object."] };
  }
  const record = parsed as Record<string, unknown>;
  const reasons: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    if (!Object.hasOwn(record, name)) {
      reasons.push(`${name} is missing`);
      continue;
    }
    const value = record[name];
    if (value === null) continue;
    reasons.push(...checkValue(name, spec, value));
  }
  return { valid: reasons.length === 0, reasons };
}

function checkValue(name: string, spec: FieldSpec, value: unknown): string[] {
  switch (spec.type) {
    case "number":
    case "duration":
      return typeof value === "number" && Number.isFinite(value) ? [] : [`${name} is not a number`];
    case "text":
      return typeof value === "string" ? [] : [`${name} is not text`];
    case "date":
      return typeof value === "string" && isoDate(value) ? [] : [`${name} is not an ISO date`];
    case "time":
      return typeof value === "string" && /^\d{2}:\d{2}(:\d{2})?$/.test(value) ? [] : [`${name} is not a time`];
    case "datetime":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? [] : [`${name} is not a datetime`];
    case "list":
      return Array.isArray(value) ? [] : [`${name} is not a list`];
    case "estimate":
      if (typeof value === "number" && Number.isFinite(value)) return [];
      if (value && typeof value === "object" && typeof (value as { median?: unknown }).median === "number") return [];
      return [`${name} is not an estimate`];
    case "forecast":
      if (Array.isArray(value)) return [];
      if (value && typeof value === "object" && (Array.isArray((value as { value?: unknown }).value) || Array.isArray((value as { median?: unknown }).median))) {
        return [];
      }
      return [`${name} is not a forecast`];
    default:
      return [`${name} has an unknown type`];
  }
}

export function validateState(state: unknown, hasImage: boolean): { ok: true; state: string } | { ok: false; message: string } {
  const text = cleanText(typeof state === "string" ? state : "").trim();
  if (!text && !hasImage) return { ok: false, message: "Paste a document or upload an image." };
  if (text.length > LIMITS.maxStateChars) {
    return { ok: false, message: `Keep the text under ${LIMITS.maxStateChars.toLocaleString("en-US")} characters.` };
  }
  return { ok: true, state: text };
}

export function parseCorrections(
  fields: Record<string, FieldSpec>,
  input: unknown,
): { ok: true; corrections: Record<string, string> } | { ok: false; message: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "Corrections must be an object." };
  const corrections: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(fields, key)) return { ok: false, message: `Unknown field “${key.slice(0, 40)}”.` };
    if (typeof value !== "string") return { ok: false, message: `${key} must be text.` };
    const cleaned = cleanText(value).trim();
    if (!cleaned) return { ok: false, message: `${key} is empty.` };
    if (cleaned.length > LIMITS.maxCorrectionChars) return { ok: false, message: `${key} is too long.` };
    corrections[key] = cleaned;
  }
  if (!Object.keys(corrections).length) return { ok: false, message: "Correct at least one field." };
  return { ok: true, corrections };
}

export function parseModelJson(raw: string): unknown {
  const fenced = raw.trim().match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no_json");
  return JSON.parse(body.slice(start, end + 1));
}
