import { describe, expect, test } from "bun:test";
import { LIMITS } from "../src/shared/limits";
import { isPrintableAsciiKey, trimUtf8, utf8ByteLength } from "../src/shared/text";
import { HttpError } from "../src/worker/errors";
import { parseMessages, parseSystem, readJson } from "../src/worker/parse";

describe("request parsing", () => {
  test("rejects a content-length over the byte cap", async () => {
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { "content-length": String(LIMITS.requestBytes + 10), "content-type": "application/json" },
      body: "{}",
    });
    await expect(readJson(req)).rejects.toBeInstanceOf(HttpError);
  });

  test("caps transcript length at 15 turns", () => {
    const messages = Array.from({ length: 16 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
    expect(() => parseMessages(messages, "")).toThrow(HttpError);
    expect(parseMessages(messages.slice(0, 15), "")).toHaveLength(15);
  });

  test("rejects a message over the UTF-8 byte cap", () => {
    const oversized = "é".repeat(LIMITS.maxMessageBytes);
    expect(utf8ByteLength(oversized)).toBeGreaterThan(LIMITS.maxMessageBytes);
    expect(() => parseMessages([{ role: "user", content: oversized }], "")).toThrow(HttpError);
    expect(isPrintableAsciiKey("sk-ok")).toBe(true);
    expect(isPrintableAsciiKey("sk no")).toBe(false);
    expect(trimUtf8("ééé", 3).length).toBeLessThanOrEqual(2);
  });

  test("system prompt uses the same UTF-8 byte unit", () => {
    expect(parseSystem("ok")).toBe("ok");
    expect(() => parseSystem("漢".repeat(LIMITS.maxSystemBytes))).toThrow(HttpError);
  });
});
