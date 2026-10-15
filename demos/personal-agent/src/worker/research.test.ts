import { expect, test } from "bun:test";
import { markdownToText, pickCatalog, validatePublicUrl } from "./research";

test("pickCatalog keeps a Durable Objects match and pads defaults", () => {
  const urls = pickCatalog("How do Durable Objects keep state?");
  expect(urls).toContain("https://developers.cloudflare.com/durable-objects/");
  expect(urls.length).toBeGreaterThanOrEqual(2);
  expect(urls.length).toBeLessThanOrEqual(3);
});

test("pickCatalog keeps a Vectorize match instead of discarding it", () => {
  const urls = pickCatalog("What is Vectorize used for?");
  expect(urls).toContain("https://developers.cloudflare.com/vectorize/");
  expect(urls.length).toBeGreaterThanOrEqual(2);
});

test("pickCatalog pads when nothing matches", () => {
  const urls = pickCatalog("zzzz not a product name");
  expect(urls).toEqual([
    "https://developers.cloudflare.com/workers/static-assets/",
    "https://developers.cloudflare.com/workers/",
  ]);
});

test("markdownToText reads YAML title and drops docs boilerplate", () => {
  const page = markdownToText(
    `---
title: Cloudflare Durable Objects
---

[Skip to content](#main-content)

> Documentation Index
> Fetch the complete documentation index at: https://developers.cloudflare.com/durable-objects/llms.txt
> Use this file to discover all available pages before exploring further.

# Cloudflare Durable Objects

Last updated Jul 15, 2026|Copy as Markdown| [View as Markdown](https://developers.cloudflare.com/durable-objects/index.md)

Durable Objects keep state close to the Worker that uses them.
`,
    "developers.cloudflare.com",
  );
  expect(page.title).toBe("Cloudflare Durable Objects");
  expect(page.text).toContain("keep state close");
  expect(page.text).not.toMatch(/skip to content/i);
  expect(page.text).not.toMatch(/documentation index/i);
  expect(page.text).not.toMatch(/fetch the complete documentation/i);
  expect(page.text).not.toMatch(/last updated/i);
});

test("markdownToText cuts at On this page", () => {
  const page = markdownToText(
    `# Cloudflare R2\n\nObject storage without egress fees.\n\n## On this page\n\n- [Buckets](#buckets)\n\n{"@context":"https://schema.org"}\n`,
    "developers.cloudflare.com",
  );
  expect(page.title).toBe("Cloudflare R2");
  expect(page.text).toContain("without egress fees");
  expect(page.text).not.toMatch(/on this page/i);
  expect(page.text).not.toContain("schema.org");
});

test("markdownToText falls back to the first heading", () => {
  const page = markdownToText("# Fetch API\n\nThe Fetch API provides an interface.\n", "developer.mozilla.org");
  expect(page.title).toBe("Fetch API");
  expect(page.text).toContain("provides an interface");
});

test("validatePublicUrl rejects private and non-https targets", () => {
  expect(validatePublicUrl("https://127.0.0.1/latest/meta-data").ok).toBe(false);
  expect(validatePublicUrl("http://169.254.169.254/latest/meta-data").ok).toBe(false);
  expect(validatePublicUrl("https://developers.cloudflare.com/workers/").ok).toBe(true);
});
