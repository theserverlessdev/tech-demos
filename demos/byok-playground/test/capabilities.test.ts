import { describe, expect, test } from "bun:test";
import { hasToolCalls, isModelNotFound, isPathNotFound, jsonSchemaOk, runCapabilities, visionNamesColour } from "../src/worker/capabilities";
import { leftColourFromPngBase64, twoPixelPng, VISION_RGB } from "../src/shared/png";

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

  test("vision matches one colour word in message.content only", () => {
    expect(visionNamesColour(JSON.stringify({ choices: [{ message: { content: "green" } }] }), "green")).toBe(true);
    expect(visionNamesColour(JSON.stringify({ choices: [{ message: { content: "red" } }] }), "green")).toBe(false);
    expect(visionNamesColour(JSON.stringify({ choices: [{ message: { content: "red or green" } }] }), "green")).toBe(false);
    expect(visionNamesColour(JSON.stringify({ choices: [{ message: { content: "I see a tiny image." } }] }), "red")).toBe(false);
    expect(visionNamesColour("red", "red")).toBe(false);
  });

  test("two-pixel PNG round-trips the left colour", () => {
    const b64 = twoPixelPng(VISION_RGB.black, VISION_RGB.white);
    expect(leftColourFromPngBase64(b64)).toBe("black");
    expect(leftColourFromPngBase64(twoPixelPng(VISION_RGB.green, VISION_RGB.blue))).toBe("green");
  });

  test("isModelNotFound only matches status >= 400 with a provider model message", () => {
    expect(isModelNotFound(200, "a ping function does not exist in this conversation")).toBe(false);
    expect(isModelNotFound(404, "Invalid URL (POST /chat/completions)")).toBe(false);
    expect(isPathNotFound(404, "Invalid URL (POST /chat/completions)")).toBe(true);
    expect(isModelNotFound(404, "model_not_found")).toBe(true);
    expect(isModelNotFound(400, "The model xyz does not exist")).toBe(true);
    expect(isModelNotFound(400, "unknown parameter")).toBe(false);
    expect(isPathNotFound(404, "nope")).toBe(true);
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

  test("a 2xx tools reply containing does not exist is not model not found", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { stream?: boolean; tools?: unknown } : {};
      if (body.stream) {
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (body.tools) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "a ping function does not exist in this conversation" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const results = await runCapabilities({
        url: "https://example.com/v1/chat/completions",
        apiKey: "sk-test-key-value",
        model: "working",
        messages: [{ role: "user", content: "ok" }],
      });
      expect(results.length).toBe(4);
      expect(results.find((row) => row.name === "tools")?.detail).not.toBe("model not found");
      expect(results.find((row) => row.name === "tools")?.status).toBe("inconclusive");
      expect(calls).toBeGreaterThanOrEqual(4);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a bare 404 is path not found, not model not found", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Invalid URL (POST /chat/completions)" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    try {
      const results = await runCapabilities({
        url: "https://example.com/chat/completions",
        apiKey: "sk-test-key-value",
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "ok" }],
      });
      expect(results[0]!.detail).toBe("endpoint path not found — check the base URL");
      expect(results[0]!.detail).not.toBe("model not found");
    } finally {
      globalThis.fetch = original;
    }
  });
});
