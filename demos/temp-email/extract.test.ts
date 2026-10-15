import { expect, test } from "bun:test";
import { extractCodes, htmlToText, replaceTags, stripBlockTags } from "./src/worker/extract.ts";

test("htmlToText is linear on a 512 KiB string of <", () => {
  const html = "<".repeat(512 * 1024);
  const start = performance.now();
  const text = htmlToText(html);
  const ms = performance.now() - start;
  expect(ms).toBeLessThan(100);
  expect(text.includes("<")).toBe(true);
});

test("htmlToText finishes on a large unclosed style tag", () => {
  const html = `<style${"x".repeat(240_000)}`;
  const start = performance.now();
  const text = htmlToText(html);
  const ms = performance.now() - start;
  expect(ms).toBeLessThan(100);
  expect(typeof text).toBe("string");
});

test("htmlToText drops script/style and keeps the code", () => {
  const html = `<html><head><title>x</title><style>.x{color:red}</style></head><body><script>alert(1)</script><p>Your verification code is 482913</p></body></html>`;
  const text = htmlToText(html);
  expect(text).not.toContain("alert");
  expect(text).not.toContain("color:red");
  expect(extractCodes("", text)).toContain("482913");
});

test("replaceTags does not scan past a nested <", () => {
  expect(replaceTags("a<b<c>d")).toBe("a<b d");
});

test("stripBlockTags drops an unclosed remainder", () => {
  expect(stripBlockTags("keep<style>secret")).toBe("keep");
});

test("extractCodes ignores a URL port next to confirm", () => {
  const text = "Or confirm your address here: http://127.0.0.1:8797/?verified=abc\nYour verification code is 404697";
  expect(extractCodes("Your Ember Cloud code is 404697", text)).toEqual(["404697"]);
});
