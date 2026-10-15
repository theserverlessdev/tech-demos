import { describe, expect, test } from "bun:test";
import {
  commitCacheSize,
  MEMORY_LIMIT,
  resetCommitCache,
  writeCommitCache,
} from "../src/worker/cache";
import type { CommitDetail } from "../src/shared/types";

function detail(hash: string): CommitDetail {
  return { hash, message: "x", parent: null, files: [] };
}

describe("commit cache", () => {
  test("the in-memory map drops the oldest entries past the cap", async () => {
    resetCommitCache();
    for (let i = 0; i < MEMORY_LIMIT + 8; i++) {
      await writeCommitCache("repo", `h${i.toString().padStart(40, "0").slice(0, 40)}`, detail(`h${i}`));
    }
    expect(commitCacheSize()).toBe(MEMORY_LIMIT);
    resetCommitCache();
    expect(commitCacheSize()).toBe(0);
  });
});
