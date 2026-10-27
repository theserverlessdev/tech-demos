import { expect, test } from "bun:test";
import { createSearch, searchConfigured } from "./search";

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

test("a missing namespace binding is not ready", async () => {
  expect(searchConfigured({})).toBe(false);
  await expect(createSearch({}).search("q")).rejects.toThrow("search_unconfigured");
  await expect(createSearch({ AI: { autorag() {} } } as never).aiSearch("q")).rejects.toThrow("search_unconfigured");
});
