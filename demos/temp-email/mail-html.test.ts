import { expect, test } from "bun:test";
import { DROP_TAGS, dropHostileTrees, frameCsp, isSafeHref, shouldDropAttr } from "./src/shared/mail-html.ts";

test("frame CSP blocks form-action", () => {
  expect(frameCsp(false)).toContain("form-action 'none'");
  expect(frameCsp(true)).toContain("form-action 'none'");
});

test("DROP_TAGS includes math and svg", () => {
  expect(DROP_TAGS).toContain("math");
  expect(DROP_TAGS).toContain("svg");
  expect(DROP_TAGS).toContain("meta");
});

test("dropHostileTrees removes the mXSS math payload before re-parse", () => {
  const mxss =
    '<math><mtext><table><mglyph><style><!--</style><style>--><meta http-equiv="refresh" content="0;url=http://127.0.0.1:8799/x"></style></mglyph></table></mtext></math><p>ok</p>';
  const out = dropHostileTrees(mxss);
  expect(out.toLowerCase()).not.toContain("<math");
  expect(out.toLowerCase()).not.toContain("<meta");
  expect(out.toLowerCase()).not.toContain("http-equiv");
  expect(out).toContain("<p>ok</p>");
});

test("dropHostileTrees removes svg xlink javascript payloads", () => {
  const svg = '<svg><a xlink:href="javascript:alert(1)">x</a></svg><p>ok</p>';
  const out = dropHostileTrees(svg);
  expect(out.toLowerCase()).not.toContain("<svg");
  expect(out.toLowerCase()).not.toContain("javascript:");
  expect(out.toLowerCase()).not.toContain("xlink:href");
  expect(out).toContain("<p>ok</p>");
});

test("href and xlink:href checks", () => {
  expect(isSafeHref("https://example.com")).toBe(true);
  expect(isSafeHref("mailto:a@b.c")).toBe(true);
  expect(isSafeHref("javascript:alert(1)")).toBe(false);
  expect(isSafeHref("data:text/html,x")).toBe(false);
  expect(shouldDropAttr("onclick")).toBe(true);
  expect(shouldDropAttr("xlink:href")).toBe(true);
  expect(shouldDropAttr("href")).toBe(false);
});
