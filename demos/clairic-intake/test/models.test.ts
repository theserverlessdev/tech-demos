import { expect, test } from "bun:test";
import type { FieldSpec } from "../src/shared/types";
import { clairicUsd, clefUsd, llamaUsd } from "../src/shared/cost";
import { readAnswers } from "../src/worker/api";
import { runClairic, runCompare, runDecide } from "../src/worker/models";

const fields: Record<string, FieldSpec> = {
  invoice_number: { type: "text" },
  total: { type: "number", unit: "USD", decimals: 2 },
  invoice_date: { type: "date" },
};

const stateText = "INVOICE #INV-2041\nTotal due: USD 25.00";

const clairicBody = {
  result: {
    model: "clairic",
    answers: {
      invoice_number: { type: "text", p_null: 0.2024, span: [8, 17], guess: "#INV-2041", confidence: 0.9973, value: "#INV-2041" },
      total: { type: "number", p_null: 0.0000063, guess: 25, confidence: 0.99996, value: 25 },
      invoice_date: { type: "date", p_null: 0.0014, guess: "2026-10-14", confidence: 0.9969, value: "2026-10-14" },
    },
    truncated: false,
    usage: { state_tokens: 58, image_tokens: 0, schema_tokens: 286, input_tokens: 402, output_tokens: 0, passes: 2 },
    state_text: stateText,
  },
  success: true,
  errors: [],
  messages: [],
};

const clefBody = {
  result: {
    answers: {
      resolution: {
        type: "choice",
        choice: "escalate",
        probabilities: { refund: 0.1, escalate: 0.8, approve: 0.1 },
        confidence: 0.7,
      },
    },
    usage: { input_tokens: 120, output_tokens: 0 },
  },
  success: true,
};

const llamaBody = {
  response: { invoice_number: "#INV-2041", total: 25, invoice_date: "2026-10-14" },
  usage: { prompt_tokens: 80, completion_tokens: 20 },
};

function liveEnv(run: (model: string) => unknown): Env {
  return {
    ENVIRONMENT: "",
    CLAIRIC_MODEL: "@cf/cloudflare/clairic",
    COMPARE_MODEL: "@cf/meta/llama-3.2-3b-instruct",
    CLEF_MODEL: "@cf/cloudflare/clef",
    AI: { run: async (model: string) => run(String(model)) },
  } as unknown as Env;
}

test("Clairic keeps list, estimate, forecast, and duration answers", async () => {
  const richFields: Record<string, FieldSpec> = {
    contacts: { type: "list", items: "text" },
    days_to_pay: { type: "estimate", unit: "days", min: 0, max: 120 },
    weekly_payout: { type: "forecast", unit: "USD", horizon: 4, interval: "week" },
    days_since_delivery: { type: "duration", unit: "days", integer: true },
  };
  const result = await runClairic(
    liveEnv(() => ({
      result: {
        answers: {
          contacts: { type: "list", value: ["Dana Ruiz", "Priya Shah"], spans: [[40, 49], [51, 61]], confidence: 0.9, p_null: 0.01 },
          days_to_pay: { type: "estimate", value: null, median: 30, p10: 21, p90: 37.5, mean: 29, unit: "days", confidence: 0.8, p_null: 0.2 },
          weekly_payout: {
            type: "forecast",
            value: [100, 80, 40, 0],
            median: [100, 80, 40, 0],
            p10: [50, 40, 10, 0],
            p90: [150, 120, 80, 20],
            steps: [{ type: "number", value: 100 }],
            unit: "USD",
            confidence: 0.7,
          },
          days_since_delivery: { type: "duration", value: 11, unit: "days", confidence: 0.95, p_null: 0.02 },
        },
        truncated: true,
        usage: { state_tokens: 10, image_tokens: 0, schema_tokens: 20, input_tokens: 30, output_tokens: 0, passes: 1 },
        state_text: "Dana Ruiz, Priya Shah",
      },
      success: true,
    })),
    "Dana Ruiz, Priya Shah",
    richFields,
    null,
    Date.parse("2026-10-22T00:00:00Z"),
  );
  expect(result.truncated).toBe(true);
  expect(result.answers.contacts.value).toEqual(["Dana Ruiz", "Priya Shah"]);
  expect(result.answers.contacts.spans).toEqual([[40, 49], [51, 61]]);
  expect(result.answers.days_to_pay.median).toBe(30);
  expect(result.answers.days_to_pay.p10).toBe(21);
  expect(result.answers.days_to_pay.p90).toBe(37.5);
  expect(result.answers.days_to_pay.mean).toBe(29);
  expect(result.answers.days_to_pay.unit).toBe("days");
  expect(result.answers.weekly_payout.value).toEqual([100, 80, 40, 0]);
  expect(result.answers.weekly_payout.median).toEqual([100, 80, 40, 0]);
  expect(result.answers.weekly_payout.steps?.[0]?.value).toBe(100);
  expect(result.answers.days_since_delivery.value).toBe(11);
  expect(result.answers.days_since_delivery.unit).toBe("days");
});

test("a real Clairic result keeps spans, usage, state text, and cost", async () => {
  const result = await runClairic(liveEnv(() => clairicBody), stateText, fields, null, Date.parse("2026-10-22T00:00:00Z"));
  expect(result.answers.invoice_number.value).toBe("#INV-2041");
  expect(result.answers.invoice_number.span).toEqual([8, 17]);
  expect(result.stateText.slice(8, 17)).toBe("#INV-2041");
  expect(result.answers.total.value).toBe(25);
  expect(result.answers.total.span).toBeUndefined();
  expect(result.answers.invoice_date.value).toBe("2026-10-14");
  expect(result.truncated).toBe(false);
  expect(result.usage).toMatchObject({ state_tokens: 58, schema_tokens: 286, input_tokens: 402, output_tokens: 0, passes: 2 });
  expect(result.costUsd).toBeCloseTo(clairicUsd(402));
});

test("a Clef choice answer becomes a decision with a cost", async () => {
  const decision = await runDecide(liveEnv(() => clefBody), {
    invoice_number: { type: "text", value: "#INV-2041", confidence: 0.99 },
  });
  expect(decision.choice).toBe("escalate");
  expect(decision.probabilities.escalate).toBe(0.8);
  expect(decision.confidence).toBe(0.7);
  expect(decision.costUsd).toBeCloseTo(clefUsd(120));
});

test("Llama JSON mode may return response as an object", async () => {
  const comparison = await runCompare(liveEnv(() => llamaBody), stateText, fields);
  expect(comparison.schemaValid).toBe(true);
  expect(comparison.parsed).toEqual(llamaBody.response);
  expect(comparison.usage.input_tokens).toBe(80);
  expect(comparison.usage.output_tokens).toBe(20);
  expect(comparison.costUsd).toBeCloseTo(llamaUsd(80, 20));
});

test("a Llama failure stays on the comparison and does not throw", async () => {
  const comparison = await runCompare(
    liveEnv(() => {
      throw new Error("compare_timeout");
    }),
    stateText,
    fields,
  );
  expect(comparison.schemaValid).toBe(false);
  expect(comparison.reasons).toEqual(["llama_failed: compare_timeout"]);
  expect(comparison.parsed).toBeNull();
  expect(comparison.costUsd).toBeNull();
});

test("client answers only keep numeric confidence, p_null, and median", () => {
  const answers = readAnswers(
    {
      invoice_number: { type: "text", value: "#INV-2041", confidence: "high", p_null: 0.2 },
      total: { type: "number", value: 25, confidence: 0.9, median: [1, "x"] },
      invoice_date: { type: "date", value: "2026-10-14", median: 3 },
    },
    fields,
  );
  expect(answers.invoice_number.confidence).toBeUndefined();
  expect(answers.invoice_number.p_null).toBe(0.2);
  expect(answers.total.median).toBeUndefined();
  expect(answers.total.confidence).toBe(0.9);
  expect(answers.invoice_date.median).toBe(3);
});
