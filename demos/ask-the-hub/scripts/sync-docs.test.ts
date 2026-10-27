import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectLocal, isDocKey, parseArgs, planDiff, runSync } from "./sync-docs.mjs";

test("keys are slug/README.md and slug/PLAN.md", () => {
  expect(isDocKey("r2-drive/README.md")).toBe(true);
  expect(isDocKey("clairic-intake/PLAN.md")).toBe(true);
  expect(isDocKey("r2-drive/notes.md")).toBe(false);
  expect(isDocKey("../README.md")).toBe(false);
});

test("unchanged files are skipped and removed demos stay until --prune", () => {
  const local = [
    { key: "r2-drive/README.md", sha256: "aaa" },
    { key: "r2-drive/PLAN.md", sha256: "bbb" },
    { key: "ask-the-hub/README.md", sha256: "ccc" },
  ];
  const remote = [
    { key: "r2-drive/README.md", sha256: "aaa" },
    { key: "r2-drive/PLAN.md", sha256: "old" },
    { key: "gone-demo/README.md", sha256: "ddd" },
    { key: "notes/secret.txt", sha256: "eee" },
  ];
  const kept = planDiff(local, remote, { prune: false });
  expect(kept.skip).toEqual(["r2-drive/README.md"]);
  expect(kept.upload).toEqual(["ask-the-hub/README.md", "r2-drive/PLAN.md"]);
  expect(kept.remove).toEqual([]);
  const pruned = planDiff(local, remote, { prune: true });
  expect(pruned.remove).toEqual(["gone-demo/README.md"]);
  const again = planDiff(
    local,
    [
      { key: "r2-drive/README.md", sha256: "aaa" },
      { key: "r2-drive/PLAN.md", sha256: "bbb" },
      { key: "ask-the-hub/README.md", sha256: "ccc" },
    ],
    { prune: true },
  );
  expect(again.upload).toEqual([]);
  expect(again.remove).toEqual([]);
  expect(again.skip).toHaveLength(3);
});

test("dry-run does not put or delete", async () => {
  const puts: string[] = [];
  const dels: string[] = [];
  const local = [{ key: "r2-drive/README.md", sha256: "abc", body: Buffer.from("hello") }];
  const remote = [{ key: "gone/PLAN.md", sha256: "old" }];
  const result = await runSync({
    local,
    remote,
    dryRun: true,
    prune: true,
    client: {
      async put(key: string) {
        puts.push(key);
      },
      async delete(key: string) {
        dels.push(key);
      },
    },
  });
  expect(puts).toEqual([]);
  expect(dels).toEqual([]);
  expect(result.actions.map((action: { op: string }) => action.op)).toEqual(["would-upload", "would-delete"]);
});

test("a real write uploads only the changed key", async () => {
  const puts: { key: string; sha256: string }[] = [];
  const local = [
    { key: "r2-drive/README.md", sha256: "same", body: Buffer.from("same") },
    { key: "r2-drive/PLAN.md", sha256: "new", body: Buffer.from("new") },
  ];
  await runSync({
    local,
    remote: [{ key: "r2-drive/README.md", sha256: "same" }],
    dryRun: false,
    prune: false,
    client: {
      async put(key: string, _body: Buffer, sha256: string) {
        puts.push({ key, sha256 });
      },
      async delete() {
        throw new Error("delete");
      },
    },
  });
  expect(puts).toEqual([{ key: "r2-drive/PLAN.md", sha256: "new" }]);
});

test("collectLocal reads README and PLAN from each demo folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ask-hub-"));
  const demos = path.join(root, "demos");
  await mkdir(path.join(demos, "r2-drive"), { recursive: true });
  await mkdir(path.join(demos, "empty-notes"), { recursive: true });
  await writeFile(path.join(demos, "r2-drive", "README.md"), "# Drive\n");
  await writeFile(path.join(demos, "r2-drive", "PLAN.md"), "# Plan\n");
  await writeFile(path.join(demos, "r2-drive", "extra.md"), "nope");
  const files = await collectLocal(demos);
  expect(files.map((file: { key: string }) => file.key)).toEqual(["r2-drive/PLAN.md", "r2-drive/README.md"]);
});

test("parseArgs defaults prune off", () => {
  expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  expect(parseArgs(["--dry-run"]).prune).toBe(false);
  expect(parseArgs(["--prune", "--bucket", "other"]).bucket).toBe("other");
  expect(parseArgs([]).bucket).toBe("tech-demos-hub-docs");
});
