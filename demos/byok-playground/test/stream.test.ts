import { describe, expect, test } from "bun:test";
import { LIMITS } from "../src/shared/limits";
import { consumeSse, encodeSse } from "../src/worker/stream";

const KEY = "sk-stream-secret-KEYVALUE";

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
}

describe("consumeSse", () => {
  test("parses a final line without a trailing newline", async () => {
    const stream = sse([`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}`]);
    const stats = await consumeSse(stream, [], Date.now());
    expect(stats.text).toBe("hello");
  });

  test("redacts once per complete line, not on the carry each chunk", async () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: `token ${KEY}` } }] });
    const stream = sse([`data: ${payload}\n`, `data: ${JSON.stringify({ choices: [{ delta: { content: "!" } }] })}\n\n`]);
    const stats = await consumeSse(stream, [KEY], Date.now());
    expect(stats.text).not.toContain(KEY);
    expect(stats.text).toContain("[redacted]");
  });

  test("stops when a carry has no newline past the cap", async () => {
    const huge = "x".repeat(LIMITS.sseCarryBytes + 8);
    await expect(consumeSse(sse([huge]), [], Date.now())).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("encodeSse", () => {
  test("emits an error frame", () => {
    expect(encodeSse("error", { message: "The endpoint timed out." })).toContain("event: error");
  });
});
