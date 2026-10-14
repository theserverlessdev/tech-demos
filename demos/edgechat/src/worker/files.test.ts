import { expect, test } from "bun:test";
import { fileResponseHeaders, isInlineImageType } from "./files.ts";

test("only png jpeg gif webp are inlined", () => {
  expect(isInlineImageType("image/png")).toBe(true);
  expect(isInlineImageType("image/jpeg")).toBe(true);
  expect(isInlineImageType("image/svg+xml")).toBe(false);
});

test("file responses are public immutable and sandbox CSP", () => {
  const headers = fileResponseHeaders({ content_type: "text/html", filename: 'hi".html', size: 12 });
  expect(headers.get("content-type")).toBe("application/octet-stream");
  expect(headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
});
