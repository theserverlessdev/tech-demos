import { describe, expect, test } from "bun:test";
import { simplePdf, stripedPng } from "../src/shared/files";
import { renderMarkdown } from "../src/shared/markdown";

describe("markdown", () => {
  test("escapes raw html and drops javascript links", () => {
    const html = renderMarkdown(`<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n[ok](https://example.com/a)`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("[click](javascript:alert(1))");
    expect(html).toContain('href="https://example.com/a"');
  });

  test("escapes attribute breakout inside a link label", () => {
    const html = renderMarkdown(`[x](https://example.com/"onclick=alert(1))`);
    expect(html).not.toContain(`"onclick`);
    expect(html).toContain("&quot;");
  });
});

describe("stand-in files", () => {
  test("png and pdf have real signatures", async () => {
    const png = await stripedPng(32, 48);
    expect(png[0]).toBe(137);
    expect(png[1]).toBe(80);
    expect(png[2]).toBe(78);
    expect(png[3]).toBe(71);
    const pdf = new TextDecoder().decode(simplePdf("Edge browser"));
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});
