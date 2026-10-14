import { describe, expect, test } from "bun:test";
import { hasToolCalls, isModelNotFound, jsonSchemaOk, runCapabilities, visionNamesLeftRed } from "../src/worker/capabilities";

describe("capability pass semantics", () => {
  test("tools passes only if tool_calls is present", () => {
    expect(hasToolCalls(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))).toBe(false);
    expect(hasToolCalls(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] }))).toBe(true);
  });

  test("json_schema requires exact keys and the nonce", () => {
    const nonce = "abc123xyz";
    expect(jsonSchemaOk(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true, nonce }) } }] }), nonce)).toBe(true);
    expect(jsonSchemaOk(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), nonce)).toBe(null);
    expect(jsonSchemaOk(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true, nonce: "nope" }) } }] }), nonce)).toBe(null);
    expect(jsonSchemaOk(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true, nonce, extra: 1 }) } }] }), nonce)).toBe(null);
  });

  test("vision requires the left-pixel colour from a two-pixel image", () => {
    expect(visionNamesLeftRed(JSON.stringify({ choices: [{ message: { content: "red" } }] }))).toBe(true);
    expect(visionNamesLeftRed(JSON.stringify({ choices: [{ message: { content: "blue" } }] }))).toBe(false);
    expect(visionNamesLeftRed(JSON.stringify({ choices: [{ message: { content: "I see a tiny image." } }] }))).toBe(false);
  });

  test("isModelNotFound matches 404 and provider codes", () => {
    expect(isModelNotFound(404, "nope")).toBe(true);
    expect(isModelNotFound(400, "model_not_found")).toBe(true);
    expect(isModelNotFound(400, "The model xyz does not exist")).toBe(true);
    expect(isModelNotFound(400, "unknown parameter")).toBe(false);
  });

  test("a wrong model id is reported once, not 4x unsupported", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "model_not_found", code: "model_not_found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const results = await runCapabilities({
        url: "https://example.com/v1/chat/completions",
        apiKey: "sk-test-key-value",
        model: "missing-model",
        messages: [{ role: "user", content: "ok" }],
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.detail).toBe("model not found");
      expect(results[0]!.status).toBe("fail");
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
