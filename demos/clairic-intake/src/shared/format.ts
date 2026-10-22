import type { Answer, FieldSpec } from "./types";

export function formatAnswer(answer: Answer | undefined): string {
  if (!answer || answer.value === null || answer.value === undefined) return "null";
  if (answer.type === "estimate") {
    const median = firstNumber(answer.median ?? answer.value);
    const p10 = firstNumber(answer.p10);
    const p90 = firstNumber(answer.p90);
    if (median === null) return String(answer.value);
    if (p10 === null || p90 === null) return String(median);
    return `${median} (80% ${p10}–${p90})`;
  }
  if (answer.type === "forecast") {
    const points = forecastPoints(answer);
    if (!points.length) return "null";
    return points.map((point) => String(point.median)).join(", ");
  }
  if (Array.isArray(answer.value)) return answer.value.map((item) => String(item)).join(", ");
  return String(answer.value);
}

export function firstNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && typeof value[0] === "number" && Number.isFinite(value[0])) return value[0];
  return null;
}

export function numberList(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

export type ForecastPoint = { median: number; p10: number; p90: number };

export function forecastPoints(answer: Answer): ForecastPoint[] {
  if (Array.isArray(answer.steps)) {
    return answer.steps.flatMap((step) => {
      if (!step || typeof step !== "object") return [];
      const record = step as Answer;
      const median = firstNumber(record.median ?? record.value);
      if (median === null) return [];
      return [{ median, p10: firstNumber(record.p10) ?? median, p90: firstNumber(record.p90) ?? median }];
    });
  }
  const medians = numberList(answer.median ?? answer.value);
  const p10s = numberList(answer.p10);
  const p90s = numberList(answer.p90);
  return medians.map((median, index) => ({
    median,
    p10: p10s[index] ?? median,
    p90: p90s[index] ?? median,
  }));
}

export type EstimateBand = { min: number; max: number; p10: number; p90: number; median: number };

export function estimateBand(answer: Answer, spec: FieldSpec | undefined): EstimateBand | null {
  const median = firstNumber(answer.median ?? answer.value);
  const p10 = firstNumber(answer.p10);
  const p90 = firstNumber(answer.p90);
  if (median === null || p10 === null || p90 === null) return null;
  const min = typeof spec?.min === "number" ? spec.min : Math.min(p10, median);
  const max = typeof spec?.max === "number" ? spec.max : Math.max(p90, median);
  if (!(max > min)) return null;
  return { min, max, p10, p90, median };
}

export function percentBetween(value: number, min: number, max: number): number {
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}
