import { describe, expect, test } from "bun:test";
import { LIMITS } from "../src/shared/limits";
import { cappedBody } from "../src/worker/proxy";
import { consumeSse, encodeSse, splitSseEvents } from "../src/worker/stream";

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

function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

function longKey(length: number): string {
  return `sk-proj-${"A".repeat(Math.max(0, length - 8))}`;
}

async function readCapped(raw: string, secrets: readonly string[], size = 50): Promise<string> {
  const upstream = new Response(chunked(raw, size), { headers: { "content-type": "text/event-stream" } });
  const body = cappedBody(upstream, secrets, { sse: true, exact: true });
  return new Response(body).text();
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

describe("splitSseEvents", () => {
  test("keeps a partial event in the remainder", () => {
    const split = splitSseEvents(": keep-alive\n\ndata: {\"x\":1}\n\ndata: {\"x\"");
    expect(split.events).toEqual([": keep-alive\n\n", "data: {\"x\":1}\n\n"]);
    expect(split.rest).toBe("data: {\"x\"");
  });
});

describe("cappedBody SSE redaction", () => {
  test("164-char key across 50-byte chunks with keep-alive comments", async () => {
    const key = longKey(164);
    expect(key.length).toBe(164);
    const payload = JSON.stringify({ choices: [{ delta: { content: `hello ${key} world` } }] });
    const raw = `: keep-alive\n\ndata: ${payload}\n\n: ping\n\ndata: [DONE]\n\n`;
    const first = await Promise.race([
      readCapped(raw, [key], 50),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("stalled")), 2_000)),
    ]);
    expect(first).not.toContain(key);
    expect(first).toContain("[redacted]");
    expect(first).toContain(": keep-alive");
    expect(first).toContain(": ping");
    expect(first).toContain("[DONE]");
    expect(first).toContain("hello");
  });

  test("400-char key across 50-byte chunks does not stall the first read", async () => {
    const key = longKey(400);
    expect(key.length).toBe(400);
    const payload = JSON.stringify({ choices: [{ delta: { content: key } }] });
    const raw = `data: ${payload}\n\ndata: [DONE]\n\n`;
    const upstream = new Response(chunked(raw, 50));
    const body = cappedBody(upstream, [key], { sse: true, exact: true });
    const reader = body.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => setTimeout(() => reject(new Error("stalled on first pull")), 2_000)),
    ]);
    expect(first.done).toBe(false);
    const decoder = new TextDecoder();
    let joined = decoder.decode(first.value, { stream: true });
    expect(joined.length).toBeGreaterThan(0);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      joined += decoder.decode(chunk.value, { stream: true });
    }
    joined += decoder.decode();
    expect(joined).not.toContain(key);
    expect(joined).toContain("[redacted]");
  });

  test("error frame starts on a fresh line after a partial event", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}"));
      },
    });
    const body = cappedBody(new Response(stream), [], { sse: true, exact: true, idleMs: 30, overallMs: 200 });
    const text = await new Response(body).text();
    expect(text).toContain("\n\nevent: error");
    expect(text).toContain("timed out waiting for the next chunk");
  });

  test("overall cap and socket loss use distinct messages", async () => {
    const hanging = new ReadableStream<Uint8Array>({ start() { /* never */ } });
    const overall = await new Response(cappedBody(new Response(hanging), [], { sse: true, idleMs: 5_000, overallMs: 0 })).text();
    expect(overall).toContain("overall time cap");

    const boom = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("ECONNRESET");
      },
    });
    const lost = await new Response(cappedBody(new Response(boom), [], { sse: true, idleMs: 200, overallMs: 1_000 })).text();
    expect(lost).toContain("connection was lost");
    expect(lost).not.toContain("overall time cap");
  });

  test("overall cap during a pending read is not labelled idle", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      },
    });
    const text = await new Response(cappedBody(new Response(stream), [], { sse: true, idleMs: 5_000, overallMs: 120 })).text();
    expect(text).toContain("overall time cap");
    expect(text).not.toContain("waiting for the next chunk");
  });

  test("single-newline data lines are forwarded without waiting for a blank line", async () => {
    const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\ndata: ${JSON.stringify({ choices: [{ delta: { content: "b" } }] })}\n`;
    const first = await Promise.race([
      readCapped(raw, [], 32),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("held back")), 1_000)),
    ]);
    expect(first).toContain("\"a\"");
    expect(first).toContain("\"b\"");
  });
});

describe("encodeSse", () => {
  test("emits an error frame", () => {
    expect(encodeSse("error", { message: "The endpoint timed out." })).toContain("event: error");
  });
});
