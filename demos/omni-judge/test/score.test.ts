import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const scoresPath = join(root, "test/preset-scores.json");

describe("preset score script", () => {
  test("without --live it leaves the committed scores alone", () => {
    const before = readFileSync(scoresPath);
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "scripts/score-presets.ts"],
      cwd: root,
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "should-not-be-used",
        CF_API_TOKEN: "should-not-be-used",
        CLOUDFLARE_ACCOUNT_ID: "should-not-be-used",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(scoresPath)).toEqual(before);
    expect(result.stdout.toString()).toContain("left test/preset-scores.json unchanged");
  });
});
