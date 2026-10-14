import { describe, expect, test } from "bun:test";
import { hasToolCalls, jsonSchemaOk, visionNamesRed } from "../src/worker/capabilities";

describe("capability pass semantics", () => {
  test("tools passes only if tool_calls is present", () => {
    expect(hasToolCalls(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))).toBe(false);
    expect(hasToolCalls(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] }))).toBe(true);
  });

  test("json_schema passes only if content parses and ok is a boolean", () => {
    expect(jsonSchemaOk(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }))).toBe(true);
    expect(jsonSchemaOk(JSON.stringify({ choices: [{ message: { content: "{\"ok\":\"yes\"}" } }] }))).toBe(null);
    expect(jsonSchemaOk(JSON.stringify({ choices: [{ message: { content: "not json" } }] }))).toBe(null);
  });

  test("vision requires the known colour in the answer", () => {
    expect(visionNamesRed(JSON.stringify({ choices: [{ message: { content: "red" } }] }))).toBe(true);
    expect(visionNamesRed(JSON.stringify({ choices: [{ message: { content: "I see a tiny image." } }] }))).toBe(false);
  });
});
