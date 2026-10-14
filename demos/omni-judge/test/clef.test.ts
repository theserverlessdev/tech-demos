import { describe, expect, test } from "bun:test";
import { buildClefRequest, buildOmniRequest, omniCost, parseOmniResponse } from "../src/shared/clef";
import type { ChoiceQuestion } from "../src/shared/types";

const questions: ChoiceQuestion[] = [
  {
    id: "q0",
    instructions: "Which team should handle this request?",
    options: [
      { id: "a", label: "Billing" },
      { id: "b", label: "Technical" },
      { id: "c", label: "Sales" },
    ],
  },
];

/** Choice answer from the Clef-omni output schema: type, choice, probabilities, confidence, usage. */
const fixture = {
  model: "clef-omni",
  answers: {
    q0: {
      type: "choice",
      choice: "b",
      probabilities: { a: 0.04, b: 0.91, c: 0.05 },
      confidence: 0.865,
    },
  },
  usage: { input_tokens: 128, output_tokens: 0 },
};

describe("clef-omni request and response", () => {
  test("an image is one data URL and each question is a choice map", () => {
    const png = Uint8Array.of(1, 2, 3, 4);
    const body = buildOmniRequest({ kind: "image", contentType: "image/png", bytes: png, durationMs: null }, questions);
    expect(body.model).toBe("clef-omni");
    expect(body.images?.[0]).toStartWith("data:image/png;base64,");
    expect(body.audio).toBeUndefined();
    expect(body.videos).toBeUndefined();
    expect(body.questions.q0).toEqual({
      type: "choice",
      instructions: "Which team should handle this request?",
      criteria: { a: "Billing", b: "Technical", c: "Sales" },
    });
  });

  test("audio and video use their own fields", () => {
    const bytes = Uint8Array.of(9, 8, 7);
    const audio = buildOmniRequest({ kind: "audio", contentType: "audio/wav", bytes, durationMs: 1000 }, questions);
    expect(audio.audio?.[0]).toStartWith("data:audio/wav;base64,");
    expect(audio.images).toBeUndefined();
    const video = buildOmniRequest({ kind: "video", contentType: "video/webm", bytes, durationMs: 1000 }, questions);
    expect(video.videos?.[0]).toStartWith("data:video/webm;base64,");
  });

  test("the schema fixture parses to the top answer and the token count", () => {
    const parsed = parseOmniResponse(fixture, questions);
    expect(parsed?.answers[0]?.topId).toBe("b");
    expect(parsed?.answers[0]?.topLabel).toBe("Technical");
    expect(parsed?.answers[0]?.bars.map((bar) => bar.probability)).toEqual([0.04, 0.91, 0.05]);
    expect(parsed?.inputTokens).toBe(128);
    expect(parseOmniResponse({ result: fixture }, questions)?.answers[0]?.topLabel).toBe("Technical");
    expect(parseOmniResponse({ success: false, result: fixture }, questions)).toBeNull();
  });

  test("a response that does not match the questions is rejected", () => {
    const missing = structuredClone(fixture);
    delete (missing.answers.q0.probabilities as { c?: number }).c;
    expect(parseOmniResponse(missing, questions)).toBeNull();
    const drifted = structuredClone(fixture);
    drifted.answers.q0.probabilities = { a: 0.5, b: 0.5, c: 0.5 };
    expect(parseOmniResponse(drifted, questions)).toBeNull();
  });

  test("cost uses input tokens at the documented rate, with no output charge", () => {
    const cost = omniCost(1_000_000, { kind: "image", contentType: "image/png", bytes: Uint8Array.of(1), durationMs: null });
    expect(cost.usd).toBeCloseTo(0.15, 6);
    const estimate = omniCost(null, { kind: "audio", contentType: "audio/wav", bytes: Uint8Array.of(1), durationMs: 60_000 });
    expect(estimate.usd).toBeCloseTo((780 * 0.15) / 1_000_000, 8);
  });

  test("the text classifier keeps the same choice map", () => {
    const body = buildClefRequest("the pump is loud", questions);
    expect(body.model).toBe("clef");
    expect(body.questions.q0?.criteria.b).toBe("Technical");
    expect(body.state).toContain("the pump is loud");
  });
});
