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

  test("rejects an oversized content-length before reading", () => {
    expect(() => rejectOversizedContentLength(new Headers({ "content-length": String(LIMITS.requestBytes + 1) }), LIMITS.requestBytes, "too big")).toThrow(HttpError);
    expect(() => rejectOversizedContentLength(new Headers({ "content-length": "12" }), LIMITS.requestBytes, "too big")).not.toThrow();
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
