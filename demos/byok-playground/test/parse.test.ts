import { describe, expect, test } from "bun:test";
import { LIMITS } from "../src/shared/limits";
import { HttpError } from "../src/worker/errors";
import { parseMessages, readJson } from "../src/worker/parse";

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
});
