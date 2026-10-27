import { expect, test } from "bun:test";
import { confirmSearch, createSearch, HEALTH_TTL_MS, searchConfigured, type HealthCache } from "./search";

test("search and answers go through the namespace binding", async () => {
  const seen: string[] = [];
  let maxResults = 0;
  const env = {
    AI_SEARCH_INSTANCE: "tech-demos-hub-docs",
    AI_SEARCH: {
      get(name: string) {
        seen.push(name);
        return {
          async search(params: { ai_search_options?: { retrieval?: { max_num_results?: number } } }) {
            maxResults = params.ai_search_options?.retrieval?.max_num_results ?? 0;
            return { data: [{ filename: "r2-drive/README.md", score: 0.5, content: [{ text: "WebDAV" }] }] };
          },
          async chatCompletions() {
            return new Response("data: hi\n\n");
          },
        };
      },
    },
  };
  expect(searchConfigured(env)).toBe(true);
  const client = createSearch(env);
  const chunks = await client.search("how does r2 drive work");
  expect(chunks[0]?.source).toBe("r2-drive/README.md");
  expect(chunks[0]?.snippet).toBe("WebDAV");
  const stream = await client.aiSearch("how does r2 drive work");
  expect(await stream.text()).toContain("hi");
  expect(maxResults).toBe(6);
  expect(seen).toEqual(["tech-demos-hub-docs", "tech-demos-hub-docs"]);
});

test("health asks the instance once and reuses the answer for 60 seconds", async () => {
  let calls = 0;
  const env = {
    AI_SEARCH_INSTANCE: "tech-demos-hub-docs",
    AI_SEARCH: {
      get(name: string) {
        return {
          async info() {
            calls += 1;
            if (name !== "tech-demos-hub-docs") throw new Error("wrong instance");
            return { id: name };
          },
          async search() {
            throw new Error("info is the cheap probe");
          },
          async chatCompletions() {
            return new Response("");
          },
        };
      },
    },
  };
  const slot: { current: HealthCache } = { current: null };
  const start = 1_700_000_000_000;
  expect(await confirmSearch(env, start, slot)).toBe(true);
  expect(await confirmSearch(env, start + HEALTH_TTL_MS - 1, slot)).toBe(true);
  expect(calls).toBe(1);
  expect(await confirmSearch(env, start + HEALTH_TTL_MS, slot)).toBe(true);
  expect(calls).toBe(2);
});

test("health stays down for 60 seconds when the instance does not answer", async () => {
  let calls = 0;
  const env = {
    AI_SEARCH: {
      get() {
        return {
          async info() {
            calls += 1;
            throw new Error("missing");
          },
          async search() {
            throw new Error("missing");
          },
          async chatCompletions() {
            return new Response("");
          },
        };
      },
    },
  };
  const slot: { current: HealthCache } = { current: null };
  expect(await confirmSearch(env, 0, slot)).toBe(false);
  expect(await confirmSearch(env, 30_000, slot)).toBe(false);
  expect(calls).toBe(1);
});

test("health falls back to a one-result search when info is missing", async () => {
  let seen = 0;
  const env = {
    AI_SEARCH: {
      get() {
        return {
          async search(params: { ai_search_options?: { retrieval?: { max_num_results?: number } } }) {
            seen = params.ai_search_options?.retrieval?.max_num_results ?? 0;
            return { data: [] };
          },
          async chatCompletions() {
            return new Response("");
          },
        };
      },
    },
  };
  const slot: { current: HealthCache } = { current: null };
  expect(await confirmSearch(env, 0, slot)).toBe(true);
  expect(seen).toBe(1);
});

test("a missing namespace binding is not ready", async () => {
  expect(searchConfigured({})).toBe(false);
  await expect(createSearch({}).search("q")).rejects.toThrow("search_unconfigured");
  await expect(createSearch({ AI: { autorag() {} } } as never).aiSearch("q")).rejects.toThrow("search_unconfigured");
});
