import { expect, test } from "bun:test";
import { HttpError } from "./api-error";
import { readCappedText } from "./body";

test("readCappedText stops a chunked body with no content-length", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(4_000)));
      controller.enqueue(new TextEncoder().encode("y".repeat(4_001)));
      controller.close();
    },
  });
  const request = new Request("http://127.0.0.1/api/rooms", { method: "POST", body: stream });
  try {
    await readCappedText(request, 8_000);
    throw new Error("expected 413");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  }
});

test("readCappedText keeps a small chunked body", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true}'));
      controller.close();
    },
  });
  const request = new Request("http://127.0.0.1/api/rooms", { method: "POST", body: stream });
  expect(await readCappedText(request, 8_000)).toBe('{"ok":true}');
});
