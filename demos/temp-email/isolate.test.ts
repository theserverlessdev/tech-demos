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

test("deploy is the self-host script; hosted uses deploy:hosted", async () => {
  const pkg = await Bun.file(join(import.meta.dir, "package.json")).json();
  expect(String(pkg.scripts.deploy)).not.toContain("wrangler.hosted");
  expect(String(pkg.scripts.deploy)).toContain("wrangler deploy");
  expect(String(pkg.scripts.deploy)).toContain("d1 migrations apply DB --remote");
  expect(String(pkg.scripts["deploy:hosted"])).toContain("wrangler.hosted.jsonc");
  const example = await Bun.file(join(import.meta.dir, ".dev.vars.example")).text();
  expect(example).not.toContain("MAIL_DOMAIN=");
  expect(example).not.toContain("HOSTED_MODE=");
  expect(example).not.toContain("PUBLIC_ORIGIN=");
});
