import { expect, test } from "bun:test";
import { DROP_TAGS, dropHostileTrees, frameCsp, isSafeHref, scrubMailDom, shouldDropAttr } from "./src/shared/mail-html.ts";

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

test("DOM pass drops xlink:href, on*, unsafe href, and leftover math", () => {
  type Fake = {
    name: string;
    attrs: Record<string, string>;
    removed: boolean;
    attributes: { name: string }[];
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    setAttribute(name: string, value: string): void;
    remove(): void;
  };
  const els: Fake[] = [];
  const el = (name: string, attrs: Record<string, string>): Fake => {
    const node: Fake = {
      name,
      attrs: { ...attrs },
      removed: false,
      get attributes() {
        return Object.keys(this.attrs).map((n) => ({ name: n }));
      },
      getAttribute(n) {
        return this.attrs[n] ?? null;
      },
      removeAttribute(n) {
        delete this.attrs[n];
      },
      setAttribute(n, v) {
        this.attrs[n] = v;
      },
      remove() {
        this.removed = true;
      },
    };
    els.push(node);
    return node;
  };
  const math = el("math", {});
  const a = el("a", { href: "javascript:alert(1)", "xlink:href": "javascript:x", onclick: "x()" });
  const ok = el("a", { href: "https://example.com" });
  const doc = {
    querySelectorAll(sel: string) {
      const live = els.filter((n) => !n.removed);
      if (sel === "*") return live;
      if (sel === "a, area") return live.filter((n) => n.name === "a" || n.name === "area");
      const tags = sel.split(",").map((s) => s.trim().toLowerCase());
      return live.filter((n) => tags.includes(n.name));
    },
  };
  scrubMailDom(doc);
  expect(math.removed).toBe(true);
  expect(a.attrs.href).toBeUndefined();
  expect(a.attrs["xlink:href"]).toBeUndefined();
  expect(a.attrs.onclick).toBeUndefined();
  expect(ok.attrs.href).toBe("https://example.com");
  expect(ok.attrs.target).toBe("_blank");
  expect(ok.attrs.rel).toBe("noopener noreferrer");
});
