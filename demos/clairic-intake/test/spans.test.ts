import { expect, test } from "bun:test";
import { escapeHtml } from "../src/shared/escape";
import { highlightHtml, marksFromAnswers, reviewFlags, segmentsFromSpans, toneFor } from "../src/shared/highlight";
import type { Answer } from "../src/shared/types";

test("escapeHtml encodes markup", () => {
  expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

test("spans highlight the value and drop out-of-range or reversed ranges", () => {
  const text = "Invoice INV-2291 from Northwind";
  const segments = segmentsFromSpans(text, [
    { start: 8, end: 16, tone: "high" },
    { start: 40, end: 50, tone: "low" },
    { start: 10, end: 4, tone: "mid" },
  ]);
  expect(segments.map((segment) => segment.text).join("")).toBe(text);
  expect(segments.find((segment) => segment.text === "INV-2291")?.tone).toBe("high");
  expect(segments.some((segment) => segment.tone === "low")).toBe(false);
});

test("overlapping spans keep the more serious tone and adjacent spans do not merge", () => {
  const segments = segmentsFromSpans("abcdef", [
    { start: 0, end: 4, tone: "high" },
    { start: 2, end: 6, tone: "low" },
  ]);
  expect(segments).toEqual([
    { text: "ab", tone: "high" },
    { text: "cdef", tone: "low" },
  ]);
});

test("highlightHtml escapes the source before wrapping marks", () => {
  const source = `<script>alert(1)</script> INV-1`;
  const start = source.indexOf("INV-1");
  const html = highlightHtml(source, [{ start, end: start + 5, tone: "high" }]);
  expect(html.startsWith("&lt;script&gt;")).toBe(true);
  expect(html.includes("<script>")).toBe(false);
  expect(html).toContain('<mark class="hl hl-high">INV-1</mark>');
});

test("null answers are flagged and their guess span is not highlighted", () => {
  const answers: Record<string, Answer> = {
    po_number: { type: "text", value: null, guess: "INV-2291", confidence: 0.4, p_null: 1, span: [8, 16] },
    total: { type: "number", value: 1080, confidence: 0.99, span: [0, 3] },
    vendor: { type: "text", value: "Northwind", confidence: 0.7 },
  };
  expect(marksFromAnswers(answers).some((mark) => mark.start === 8)).toBe(false);
  expect(marksFromAnswers(answers)).toEqual([{ start: 0, end: 3, tone: "high" }]);
  const flags = reviewFlags(answers).map((flag) => flag.field);
  expect(flags).toContain("po_number");
  expect(flags).toContain("vendor");
  expect(flags).not.toContain("total");
  expect(toneFor(0.5, false)).toBe("low");
  expect(toneFor(0.7, false)).toBe("mid");
  expect(toneFor(0.9, true)).toBe("null");
});
