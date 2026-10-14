import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/worker/errors";
import { readApiKey, validateChatJson, validateModelsPayload } from "../src/worker/proxy";
import { rejectOversizedContentLength } from "../src/worker/bytes";
import { LIMITS } from "../src/shared/limits";

describe("proxy request and response shape", () => {
  test("reads the API key from the JSON body, not a header", () => {
    expect(readApiKey({ apiKey: "sk-from-body-value" })).toBe("sk-from-body-value");
    expect(() => readApiKey({})).toThrow(HttpError);
  });

  test("rejects keys that are not printable ASCII", () => {
    expect(() => readApiKey({ apiKey: "sk-has space" })).toThrow(HttpError);
    expect(() => readApiKey({ apiKey: "sk-emoji-😀" })).toThrow(HttpError);
    expect(() => readApiKey({ apiKey: "sk-has\nnewline" })).toThrow(HttpError);
    expect(readApiKey({ apiKey: "sk-proj-ABC_def.123+/=~" })).toBe("sk-proj-ABC_def.123+/=~");
  });

  test("rejects an oversized content-length before reading", () => {
    expect(() => rejectOversizedContentLength(new Headers({ "content-length": String(LIMITS.requestBytes + 1) }), LIMITS.requestBytes, "too big")).toThrow(HttpError);
    expect(() => rejectOversizedContentLength(new Headers({ "content-length": "12" }), LIMITS.requestBytes, "too big")).not.toThrow();
  });

  test("oversized upstream responses are 502", () => {
    try {
      rejectOversizedContentLength(new Headers({ "content-length": "999999" }), 100, "The endpoint response was too large.", 502);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(502);
    }
  });

  test("/models keeps only { data: [{ id }] }", () => {
    const out = validateModelsPayload(JSON.stringify({ data: [{ id: "gpt-4.1-mini", object: "model", owned_by: "openai" }, { object: "model" }] }));
    expect(out).toEqual({ data: [{ id: "gpt-4.1-mini" }] });
    expect(() => validateModelsPayload(JSON.stringify({ models: [] }))).toThrow(HttpError);
  });

  test("non-stream chat requires JSON with choices", () => {
    expect(validateChatJson(JSON.stringify({ choices: [{ message: { content: "hi" } }] }))).toMatchObject({ choices: [{}] });
    expect(() => validateChatJson(JSON.stringify({ text: "hi" }))).toThrow(HttpError);
  });
});
