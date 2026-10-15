import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "../src/shared/limits";
import { sniffMedia } from "../src/shared/media";
import { PRESETS, PRESET_GROUPS, SAMPLES, validateQuestions } from "../src/shared/questions";
import { SAMPLE_IDS } from "../src/shared/types";

const samplesDir = join(import.meta.dir, "../public/samples");

describe("real-world presets", () => {
  test("every sample id has a file that sniffs inside the caps", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...SAMPLE_IDS].sort());
    for (const id of SAMPLE_IDS) {
      const sample = SAMPLES[id];
      const bytes = new Uint8Array(readFileSync(join(samplesDir, sample.file)));
      const cap = sample.kind === "image" ? LIMITS.maxImageBytes : sample.kind === "audio" ? LIMITS.maxAudioBytes : LIMITS.maxVideoBytes;
      expect(bytes.length).toBeGreaterThan(800);
      expect(bytes.length).toBeLessThanOrEqual(cap);
      const sniffed = sniffMedia(bytes);
      expect(sniffed).toMatchObject({ ok: true, kind: sample.kind });
      if (sniffed.ok && sample.kind !== "image") {
        expect(sniffed.durationMs).toBeGreaterThan(500);
        expect(sniffed.durationMs).toBeLessThanOrEqual(sample.kind === "audio" ? LIMITS.maxAudioMs : LIMITS.maxVideoMs + LIMITS.videoSlackMs);
      }
    }
  });

  test("each preset has a question, labelled options, and an expected answer", () => {
    expect(PRESETS.map((preset) => preset.group)).toEqual(PRESET_GROUPS.flatMap((group) => PRESETS.filter((preset) => preset.group === group).map(() => group)));
    for (const preset of PRESETS) {
      const validated = validateQuestions(preset.questions);
      expect(validated.ok).toBe(true);
      if (!validated.ok) continue;
      expect(preset.questions[0]?.options).toContain(preset.expected);
      expect(preset.sample).toBeTruthy();
      expect(SAMPLES[preset.sample]).toBeTruthy();
      expect(preset.proves.length).toBeGreaterThan(20);
      expect(preset.tryHint.length).toBeGreaterThan(10);
    }
  });
});
