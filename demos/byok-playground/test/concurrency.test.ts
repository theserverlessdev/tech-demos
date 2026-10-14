import { describe, expect, test } from "bun:test";
import { currentConcurrency, holdUntilClose, resetConcurrency } from "../src/worker/concurrency";

describe("stream concurrency", () => {
  test("releases the slot when the body closes, is cancelled, or errors", async () => {
    resetConcurrency();
    const inner = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hi"));
        controller.close();
      },
    });
    const wrapped = holdUntilClose("1.1.1.1", inner);
    expect(currentConcurrency().total).toBe(1);
    await new Response(wrapped).text();
    expect(currentConcurrency().total).toBe(0);

    const cancellable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stay"));
      },
    });
    const held = holdUntilClose("8.8.8.8", cancellable);
    expect(currentConcurrency().total).toBe(1);
    await held.cancel();
    expect(currentConcurrency().total).toBe(0);
  });
});
