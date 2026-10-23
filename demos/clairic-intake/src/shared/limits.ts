export const LIMITS = {
  maxFields: 12,
  maxInstructions: 240,
  maxUnit: 32,
  maxStateChars: 12_000,
  maxImageBytes: 1_500_000,
  maxImages: 1,
  /** Base64 of a 1.5 MB image, plus the text field and JSON overhead. */
  maxBodyBytes: Math.ceil((1_500_000 * 4) / 3) + 12_000 * 6 + 64 * 1024,
  dailyCalls: 40,
  /** Shared ceiling for every network. The '*' spend row holds this total. */
  dailyGlobalCalls: 200,
  /** A running inbox row can be claimed again after this. */
  leaseMs: 60_000,
  retentionMs: 24 * 60 * 60 * 1000,
  /** Under this confidence, or a null value, the field is flagged for review. */
  reviewConfidence: 0.8,
  lowConfidence: 0.6,
  highConfidence: 0.85,
  maxHorizon: 16,
  maxCorrectionChars: 200,
  clefFloor: 0.62,
  inboxSize: 12,
} as const;

export const CLAIRIC_MODEL_ID = "@cf/cloudflare/clairic";
export const COMPARE_MODEL_ID = "@cf/meta/llama-3.2-3b-instruct";
export const CLEF_MODEL_ID = "@cf/cloudflare/clef";

/** Prices from the Workers AI model pages. Clairic and Clef bill input tokens only. */
export const PRICES = {
  clairicPerMInput: 0.1,
  llamaPerMInput: 0.0509,
  llamaPerMOutput: 0.335,
  clefPerMInput: 0.24,
} as const;

export const MOCK_LATENCY_MS = {
  clairic: 180,
  llama: 940,
  clef: 160,
} as const;

export const FIELD_TYPES = [
  "text",
  "number",
  "date",
  "time",
  "datetime",
  "duration",
  "list",
  "estimate",
  "forecast",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const DURATION_UNITS = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"] as const;
export const FORECAST_INTERVALS = ["step", "minute", "hour", "day", "week", "month", "quarter", "year"] as const;
export const DECISIONS = ["refund", "escalate", "approve"] as const;
export type Decision = (typeof DECISIONS)[number];

export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
