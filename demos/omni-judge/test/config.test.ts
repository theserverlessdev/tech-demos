import { expect, test } from "bun:test";

test("local and live wrangler names cannot overwrite the production worker", async () => {
  const prod = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text();
  const local = await Bun.file(new URL("../wrangler.local.jsonc", import.meta.url)).text();
  const live = await Bun.file(new URL("../wrangler.live.jsonc", import.meta.url)).text();
  expect(prod).toContain('"name": "tech-demos-omni-judge"');
  expect(local).toContain('"name": "tech-demos-omni-judge-dev"');
  expect(live).toContain('"name": "tech-demos-omni-judge-live"');
  expect(local).not.toContain('"name": "tech-demos-omni-judge"');
  expect(live).not.toContain('"name": "tech-demos-omni-judge"');
});
