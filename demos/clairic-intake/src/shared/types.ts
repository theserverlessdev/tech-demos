import type { Decision, FieldType } from "./limits";

export type FieldSpec = {
  type: FieldType;
  instructions?: string;
  unit?: string;
  integer?: boolean;
  decimals?: number;
  items?: "text" | "number" | "date";
  min?: number | string;
  max?: number | string;
  step?: number | string;
  scale?: "linear" | "log";
  null_threshold?: number;
  horizon?: number;
  interval?: string;
};

export type Answer = {
  type: string;
  value: unknown;
  guess?: unknown;
  p_null?: number;
  confidence?: number;
  span?: [number, number];
  spans?: [number, number][];
  unit?: string;
  mean?: number;
  median?: number | number[];
  p10?: number | number[];
  p90?: number | number[];
  p_below?: number;
  p_above?: number;
  steps?: Answer[];
};

export type Usage = {
  state_tokens: number;
  image_tokens: number;
  schema_tokens: number;
  input_tokens: number;
  output_tokens: number;
  passes: number;
};

export type ReviewFlag = { field: string; reason: string };

export type Comparison = {
  source: "llama" | "mock";
  model: string;
  latencyMs: number;
  /** Null when the instruct call failed and may not have been billed. */
  costUsd: number | null;
  schemaValid: boolean;
  reasons: string[];
  parsed: unknown;
  rawPreview: string;
  usage: Usage;
};

export type Extraction = {
  source: "clairic" | "mock";
  model: string;
  stateText: string;
  answers: Record<string, Answer>;
  usage: Usage;
  latencyMs: number;
  costUsd: number;
  review: ReviewFlag[];
  photoUnread: boolean;
  /** Clairic set this when the document did not fit in one pass. */
  truncated: boolean;
  comparison?: Comparison;
};

export type DeskDecision = {
  source: "clef" | "mock";
  model: string;
  choice: Decision;
  probabilities: Record<Decision, number>;
  confidence: number;
  reason: string;
  latencyMs: number;
  costUsd: number;
};

export type InboxDoc = {
  id: string;
  title: string;
  preset: "invoice" | "support" | "insurance";
  state: string;
};
