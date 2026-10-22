import { LIMITS } from "./limits";
import type { Answer, ReviewFlag } from "./types";
import { escapeHtml } from "./escape";

export type Tone = "high" | "mid" | "low" | "null";

export type SpanMark = { start: number; end: number; tone: Tone };

export type Segment = { text: string; tone: Tone | null };

const PRIORITY: Record<Tone, number> = { null: 4, low: 3, mid: 2, high: 1 };

export function toneFor(confidence: number | null, valueIsNull: boolean): Tone {
  if (valueIsNull) return "null";
  if (confidence === null || !Number.isFinite(confidence) || confidence < LIMITS.lowConfidence) return "low";
  if (confidence < LIMITS.highConfidence) return "mid";
  return "high";
}

export function segmentsFromSpans(text: string, marks: SpanMark[]): Segment[] {
  const n = text.length;
  const events: { at: number; open: boolean; tone: Tone }[] = [];
  for (const mark of marks) {
    if (!Number.isFinite(mark.start) || !Number.isFinite(mark.end)) continue;
    const start = Math.max(0, Math.min(n, Math.floor(mark.start)));
    const end = Math.max(0, Math.min(n, Math.floor(mark.end)));
    if (end <= start) continue;
    events.push({ at: start, open: true, tone: mark.tone });
    events.push({ at: end, open: false, tone: mark.tone });
  }
  events.sort((a, b) => a.at - b.at || Number(a.open) - Number(b.open) || PRIORITY[b.tone] - PRIORITY[a.tone]);

  const counts: Record<Tone, number> = { high: 0, mid: 0, low: 0, null: 0 };
  const segments: Segment[] = [];
  let cursor = 0;

  function current(): Tone | null {
    if (counts.null) return "null";
    if (counts.low) return "low";
    if (counts.mid) return "mid";
    if (counts.high) return "high";
    return null;
  }

  function push(to: number, tone: Tone | null) {
    if (to <= cursor) return;
    const slice = text.slice(cursor, to);
    const prev = segments[segments.length - 1];
    if (prev && prev.tone === tone) prev.text += slice;
    else segments.push({ text: slice, tone });
    cursor = to;
  }

  for (const event of events) {
    push(event.at, current());
    counts[event.tone] += event.open ? 1 : -1;
  }
  push(n, current());
  return segments;
}

/** Escapes every text segment, then wraps highlights. The class is a fixed tone, not user text. */
export function highlightHtml(text: string, marks: SpanMark[]): string {
  return segmentsFromSpans(text, marks)
    .map((segment) => {
      const safe = escapeHtml(segment.text);
      if (!segment.tone) return safe;
      return `<mark class="hl hl-${segment.tone}">${safe}</mark>`;
    })
    .join("");
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const start = value[0];
  const end = value[1];
  if (typeof start !== "number" || typeof end !== "number") return null;
  return [start, end];
}

/** Highlight a value only when it is present. A null answer's guess span stays out of the source. */
export function marksFromAnswers(answers: Record<string, Answer>): SpanMark[] {
  const marks: SpanMark[] = [];
  for (const answer of Object.values(answers)) {
    if (answer.value === null || answer.value === undefined) continue;
    const tone = toneFor(typeof answer.confidence === "number" ? answer.confidence : null, false);
    const span = pair(answer.span);
    if (span) marks.push({ start: span[0], end: span[1], tone });
    if (Array.isArray(answer.spans)) {
      for (const item of answer.spans) {
        const next = pair(item);
        if (next) marks.push({ start: next[0], end: next[1], tone });
      }
    }
  }
  return marks;
}

export function reviewFlags(answers: Record<string, Answer>): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const [field, answer] of Object.entries(answers)) {
    if (answer.value === null || answer.value === undefined) {
      flags.push({ field, reason: "null — the input does not determine this value" });
      continue;
    }
    if (typeof answer.p_null === "number" && answer.p_null >= 0.5) {
      flags.push({ field, reason: "p_null is at least 0.5" });
      continue;
    }
    if (typeof answer.confidence === "number" && answer.confidence < LIMITS.reviewConfidence) {
      flags.push({ field, reason: "confidence is under 0.8" });
    }
  }
  return flags;
}
