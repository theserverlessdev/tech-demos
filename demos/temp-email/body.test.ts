import { expect, test } from "bun:test";
import { HttpError, readCapped } from "./src/worker/api.ts";

test("readCapped rejects a large content-length before reading", async () => {
  const req = new Request("https://example.com", {
    method: "POST",
    headers: { "content-length": "100000" },
    body: "x",
  });
  try {
    await readCapped(req, 16 * 1024);
    throw new Error("expected HttpError");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  }
});

test("readCapped stops when the stream exceeds the cap", async () => {
  const body = "n".repeat(100);
  const req = new Request("https://example.com", { method: "POST", body });
  try {
    await readCapped(req, 32);
    throw new Error("expected HttpError");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  }
});

test("readCapped returns a small JSON body", async () => {
  const req = new Request("https://example.com", { method: "POST", body: '{"a":1}' });
  const bytes = await readCapped(req, 1024);
  expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
});
