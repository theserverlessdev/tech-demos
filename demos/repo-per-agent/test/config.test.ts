import { expect, test } from "bun:test";

test("workers.dev is off because zone routes are the public URLs", async () => {
  const wrangler = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text();
  expect(wrangler).toContain('"workers_dev": false');
  expect(wrangler).not.toContain('"workers_dev": true');
});
