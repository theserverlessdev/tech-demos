import { expect, test } from "bun:test";
import { clipAttachmentPart, contentDisposition, storeAttachments } from "./src/worker/attachments.ts";
import { MAX_ATTACHMENTS, MAX_DISPOSITION_FILENAME, MAX_HEADER_CHARS } from "./src/worker/limits.ts";

function mockBucket(): R2Bucket {
  const objects = new Map<string, ArrayBuffer | string>();
  return {
    put: async (key: string, value: ArrayBuffer | string) => {
      objects.set(key, value);
      return { key } as R2Object;
    },
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    list: async (opts?: { prefix?: string }) => {
      const listed = [...objects.keys()]
        .filter((key) => !opts?.prefix || key.startsWith(opts.prefix))
        .map((key) => ({ key }));
      return { objects: listed, truncated: false };
    },
  } as unknown as R2Bucket;
}

test("attachment filename and mimeType cap at 2 KB", () => {
  const meta = clipAttachmentPart({
    filename: "x".repeat(MAX_HEADER_CHARS + 40),
    mimeType: "y".repeat(MAX_HEADER_CHARS + 10),
    disposition: "z".repeat(MAX_HEADER_CHARS + 5),
  });
  expect(meta.filename?.length).toBe(MAX_HEADER_CHARS);
  expect(meta.mimeType.length).toBe(MAX_HEADER_CHARS);
  expect(meta.disposition?.length).toBe(MAX_HEADER_CHARS);
});

test("Content-Disposition filename clips to 255 characters", () => {
  const disp = contentDisposition("x".repeat(MAX_HEADER_CHARS + 40));
  const star = disp.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? "";
  expect(decodeURIComponent(star).length).toBe(MAX_DISPOSITION_FILENAME);
  expect(disp.length).toBeLessThan(8192);
});

test("storeAttachments keeps at most 20 parts and clips metadata", async () => {
  expect(MAX_ATTACHMENTS).toBe(20);
  const bucket = mockBucket();
  const parts = Array.from({ length: 40 }, (_, i) => ({
    filename: i === 0 ? `${"x".repeat(MAX_HEADER_CHARS + 40)}.bin` : `f-${i}.txt`,
    mimeType: "text/plain",
    content: new TextEncoder().encode(`p${i}`),
  }));
  const stored = await storeAttachments(bucket, "box", "msg", parts);
  expect(stored).toHaveLength(MAX_ATTACHMENTS);
  expect(stored[0].filename?.length).toBe(MAX_HEADER_CHARS);
  expect(stored.every((part) => part.r2Key)).toBe(true);
  expect(stored.every((part) => (part.filename?.length ?? 0) <= MAX_HEADER_CHARS)).toBe(true);
});
