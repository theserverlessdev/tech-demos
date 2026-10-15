import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

async function collectTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectTs(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("worker sources do not import outside this folder", async () => {
  const files = await collectTs(join(import.meta.dir, "src/worker"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const src = await Bun.file(file).text();
    expect(src, file).not.toContain("packages/shared");
    expect(src, file).not.toMatch(/from\s+["']\.\.\/\.\.\/\.\.\//);
  }
});
