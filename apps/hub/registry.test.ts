import { expect, test } from "bun:test";
import { demoPath } from "@tech-demos/shared";
import { demos, getDemo } from "./src/registry.ts";

test("hello-dynamic is the only loader demo and its source is the Text module", () => {
  const loaders = demos.filter((d) => d.kind === "loader");
  expect(loaders.map((d) => d.slug)).toEqual(["hello-dynamic"]);
  const hello = getDemo("hello-dynamic");
  expect(hello?.source).toContain("function escapeHtml");
  expect(hello?.source).toContain("Array.from(raw).slice(0, 64)");
  expect(hello?.source).toContain("← All demos");
  expect(hello?.source).toContain("x-dynamic-worker");
  expect(hello?.source).toContain('<form method="get">');
  expect(hello?.demonstrates).toContain("reuses it while it stays warm");
  expect(hello?.capabilities.join(" ")).toContain("Type a name in the form");
  expect(hello?.useCases.join(" ")).toContain("KV or R2");
});

test("standalone fallbacks use redirectSource with a path boundary", () => {
  for (const demo of demos.filter((d) => d.kind === "standalone")) {
    expect(demo.source).toContain(`const slug = "${demo.slug}"`);
    expect(demo.source).toContain("url.pathname.startsWith(prefix + \"/\")");
    expect(demo.source).toContain("new URL(rest || \"/\", origin)");
  }
  expect(getDemo("temp-email")?.source).toContain("https://email.lomvic.com");
});

test("registry copy and tags from the audit", () => {
  expect(getDemo("cloudflare-os")?.description).toContain(
    "each gadget is a sandboxed Durable Object facet with its own SQLite",
  );
  expect(getDemo("apollo-desk")?.demonstrates).toContain("an MCP-style JSON-RPC tool server");
  expect(getDemo("partyserver")?.capabilities.join(" ")).toContain("8 connections");
  expect(getDemo("feedlog")?.capabilities.join(" ")).toContain("See the 'matched on words' note when Vectorize is unavailable");
  expect(getDemo("company-brain")?.capabilities.join(" ")).toContain("the ingest token returned at creation");
  expect(getDemo("apollo-desk")?.capabilities.join(" ")).toContain("an MCP-style JSON-RPC tool server");
  expect(getDemo("clef-gate")?.demonstrates).toContain("or ten minutes pass");
  expect(getDemo("clef-gate")?.capabilities.join(" ")).toContain("or ten minutes pass");
  expect(getDemo("actor-lab")?.capabilities.join(" ")).toContain("usually ends below");
  expect(getDemo("repo-per-agent")?.capabilities.join(" ")).toContain(
    "An unchanged model response is reported as an error and commits nothing",
  );
  expect(getDemo("memory-repo")?.demonstrates).toContain("per visitor");
  expect(getDemo("memory-repo")?.demonstrates).toContain("deleted 24 h after the last activity");
  expect(getDemo("memory-repo")?.useCases.join(" ")).toContain("memory that lives in a git repo");
  expect(getDemo("edgechat")?.capabilities.join(" ")).toContain("the last 80 messages");

  expect(getDemo("personal-agent")?.tags).toContain("turnstile");
  expect(getDemo("partyserver")?.tags).toContain("turnstile");
  expect(getDemo("clef-gate")?.tags).toContain("turnstile");
  expect(getDemo("tanbase")?.tags).toContain("turnstile");
  expect(getDemo("temp-email")?.tags).toContain("r2");
  expect(getDemo("temp-email")?.tags).toContain("turnstile");
  expect(getDemo("repo-per-agent")?.tags).toContain("durable-objects");
  expect(getDemo("memory-repo")?.tags).toContain("durable-objects");
  expect(getDemo("cloudflare-os")?.tags).toContain("durable-objects");
});

test("demoPath helper used by the API has a trailing slash", () => {
  expect(demoPath("edgechat")).toBe("/demos/edgechat/");
});
