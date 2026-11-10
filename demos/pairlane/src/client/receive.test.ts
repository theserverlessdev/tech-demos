import { expect, test } from "bun:test";
import { receivedFile } from "./receive";

test("a received file is always octet-stream, whatever MIME the sender claimed", () => {
  const html = new TextEncoder().encode("<html></html>");
  const bytes = new Uint8Array(html.byteLength);
  bytes.set(html);
  const blob = receivedFile(bytes);
  expect(blob.type).toBe("application/octet-stream");
  expect(blob.size).toBe(html.byteLength);
});
