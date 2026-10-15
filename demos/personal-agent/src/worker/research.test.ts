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
title: Durable Objects
pcx_content_type: overview
---

# Durable Objects

Skip to content

Documentation Index

Fetch the complete documentation index as a Markdown file.

Durable Objects keep state close to the Worker that uses them.
`,
    "developers.cloudflare.com",
  );
  expect(page.title).toBe("Durable Objects");
  expect(page.text).toContain("keep state close");
  expect(page.text).not.toContain("Skip to content");
  expect(page.text).not.toContain("Documentation Index");
  expect(page.text).not.toContain("Fetch the complete documentation");
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
