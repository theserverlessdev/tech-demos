import { expect, test } from "bun:test";

test("mock flags on a public host refuse the API before a session exists", () => {
  const root = new URL("../..", import.meta.url);
  const proc = Bun.spawnSync({
    cmd: ["bun", "scripts/check-public-mock.ts"],
    cwd: root.pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  if (proc.exitCode !== 0) throw new Error(stderr || stdout || "public mock gate failed");
  expect(stdout).toContain("public mock gate ok");
});
