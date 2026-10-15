import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collapseWhitespace,
  extractCodes,
  htmlToText,
  replaceTags,
  snippetOf,
  stripBlockTags,
} from "./src/worker/extract.ts";
import { SNIPPET_CHARS } from "./src/worker/limits.ts";

test("htmlToText is linear on 64 KiB of < (at the input cap)", () => {
  const html = "<".repeat(64 * 1024);
  const start = performance.now();
  const text = htmlToText(html);
  const ms = performance.now() - start;
  expect(ms).toBeLessThan(100);
  expect(text.includes("<")).toBe(true);
});

test("htmlToText caps a 512 KiB string of < rather than scanning it all", () => {
  const html = "<".repeat(512 * 1024);
  const start = performance.now();
  htmlToText(html);
  expect(performance.now() - start).toBeLessThan(100);
});

test("htmlToText finishes on a 32 KiB unclosed style tag under the cap", () => {
  const html = `<style${"x".repeat(32_000)}`;
  const start = performance.now();
  const text = htmlToText(html);
  expect(performance.now() - start).toBeLessThan(100);
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

test("stripBlockTags indices stay aligned when the input has ß", () => {
  expect(stripBlockTags("okß<style>no</style>yes")).toBe("okßyes");
});

test("extractCodes ignores a URL port next to confirm", () => {
  const text = "Or confirm your address here: http://127.0.0.1:8797/?verified=abc\nYour verification code is 404697";
  expect(extractCodes("Your Ember Cloud code is 404697", text)).toEqual(["404697"]);
});

test("collapseWhitespace does not reread the output string", () => {
  expect(collapseWhitespace("a   a\n\n\nb")).toBe("a a\nb");
  const n = 32 * 1024;
  const time = (s: string) => {
    const start = performance.now();
    collapseWhitespace(s);
    return performance.now() - start;
  };
  const t1 = time("a".repeat(n));
  const t2 = time("a".repeat(n * 2));
  expect(t2).toBeLessThan(500);
  expect(t2).toBeLessThan(Math.max(50, t1 * 8));
});

test("snippetOf slices before collapsing and stays short", () => {
  const snip = snippetOf("a ".repeat(100_000));
  expect(snip.length).toBeLessThanOrEqual(SNIPPET_CHARS);
  expect(snippetOf("hello\nworld")).toBe("hello world");
});

test("collapseWhitespace is linear at the 64K cap under V8", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-v8-"));
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "src/worker/extract.ts")],
      target: "node",
      format: "esm",
      outdir: dir,
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    const proc = Bun.spawnSync(
      [
        "node",
        "--input-type=module",
        "-e",
        `import { collapseWhitespace, htmlToText, snippetOf } from ${JSON.stringify(join(dir, "extract.js"))};
         const n = 32 * 1024;
         const time = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
         const t1 = time(() => collapseWhitespace("a".repeat(n)));
         const t2 = time(() => collapseWhitespace("a".repeat(n * 2)));
         const th = time(() => htmlToText("<".repeat(n * 2)));
         const snip = snippetOf("a ".repeat(n * 2));
         if (t2 > 500 || th > 500) { console.error("slow", { t1, t2, th }); process.exit(1); }
         if (t2 > Math.max(50, t1 * 8)) { console.error("quadratic", { t1, t2 }); process.exit(1); }
         if (snip.length > 160) process.exit(2);
         console.log(JSON.stringify({ t1, t2, th }));`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const err = proc.stderr.toString();
    expect(proc.exitCode, err || proc.stdout.toString()).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
