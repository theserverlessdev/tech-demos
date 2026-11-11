import { expect, test } from "bun:test";

const PROD_D1 = "67b63062-595d-48dc-a13c-2585dbeb5612";

test("local wrangler does not bind production D1 or R2", async () => {
  const local = await Bun.file(new URL("../wrangler.local.jsonc", import.meta.url)).text();
  const prod = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text();
  expect(prod).toContain(PROD_D1);
  expect(prod).toContain('"name": "tech-demos-tanbase"');
  expect(local).toContain('"name": "tech-demos-tanbase-local"');
  expect(local).not.toContain(PROD_D1);
  expect(local).toContain("00000000-0000-4000-8000-000000007540");
  expect(local).toContain("tech-demos-tanbase-local");
  expect(local).not.toMatch(/"bucket_name": "tech-demos-tanbase"/);
});
