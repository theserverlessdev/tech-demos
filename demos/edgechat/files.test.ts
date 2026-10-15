import { expect, test } from "bun:test";
import { fileResponseHeaders, isInlineImageType } from "./src/worker/files.ts";

test("only png jpeg gif webp are inlined", () => {
  expect(isInlineImageType("image/png")).toBe(true);
  expect(isInlineImageType("image/jpeg")).toBe(true);
  expect(isInlineImageType("image/gif")).toBe(true);
  expect(isInlineImageType("image/webp")).toBe(true);
  expect(isInlineImageType("image/svg+xml")).toBe(false);
  expect(isInlineImageType("text/html")).toBe(false);
  expect(isInlineImageType("text/plain")).toBe(false);
});

test("non-images are attachments with octet-stream and a sandbox CSP", () => {
  const headers = fileResponseHeaders({ content_type: "text/html", filename: 'hi".html', size: 12 });
  expect(headers.get("content-type")).toBe("application/octet-stream");
  expect(headers.get("content-disposition")).toBe('attachment; filename="hi.html"');
  expect(headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
});

test("images stay inline with their real type", () => {
  const headers = fileResponseHeaders({ content_type: "image/png", filename: "pic.png", size: 4 });
  expect(headers.get("content-type")).toBe("image/png");
  expect(headers.get("content-disposition")).toBe('inline; filename="pic.png"');
  expect(headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
});
