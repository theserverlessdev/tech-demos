import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOmniRequest, parseOmniResponse } from "../src/shared/clef";
import { sniffMedia } from "../src/shared/media";
import { PRESETS, SAMPLES, validateQuestions } from "../src/shared/questions";
import { LIMITS } from "../src/shared/limits";
import type { JudgmentAnswer } from "../src/shared/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const samplesDir = join(root, "public/samples");
const outFile = join(root, "test/preset-scores.json");
const requireAi = process.argv.includes("--require-ai");
const minMargin = Number(process.env.PRESET_MARGIN ?? "0.15");

export type PresetScore = {
  id: string;
  sample: string;
  file: string;
  question: string;
  expected: string;
  topLabel: string | null;
  expectedP: number | null;
  nextP: number | null;
  margin: number | null;
  confidence: number | null;
  latencyMs: number | null;
  source: "clef-omni" | "skipped";
  ok: boolean;
  note: string;
};

function fail(message: string): never {
  console.error("FAIL", message);
  process.exit(1);
}

function accountId(): string {
  return process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || "3f847e2fadeef3e583701e8fa25657b5";
}

function apiToken(): string {
  return process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CF_API_TOKEN?.trim() || "";
}

async function runOmni(bytes: Uint8Array, contentType: string, kind: "image" | "audio" | "video", questions: ReturnType<typeof validateQuestions> & { ok: true }): Promise<{ answers: JudgmentAnswer[]; latencyMs: number }> {
  const media = { kind, contentType, bytes, durationMs: null as number | null };
  const sniffed = sniffMedia(bytes);
  if (sniffed.ok) media.durationMs = sniffed.durationMs;
  const body = buildOmniRequest(media, questions.questions);
  const started = Date.now();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId()}/ai/run/@cf/cloudflare/clef-omni`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = (await res.json()) as unknown;
  if (!res.ok) {
    fail(`Workers AI HTTP ${res.status} ${JSON.stringify(raw).slice(0, 400)}`);
  }
  const parsed = parseOmniResponse(raw, questions.questions);
  if (!parsed) fail(`Clef-omni response could not be read: ${JSON.stringify(raw).slice(0, 600)}`);
  return { answers: parsed.answers, latencyMs: Date.now() - started };
}

const token = apiToken();
const live = token.length > 0;
if (!live && requireAi) fail("Workers AI token missing. Set CLOUDFLARE_API_TOKEN.");
if (!live) console.log("Workers AI is not available. Checking bundled files only.");

const scores: PresetScore[] = [];
let failed = 0;

for (const preset of PRESETS) {
  const sample = SAMPLES[preset.sample];
  const path = join(samplesDir, sample.file);
  const file = Bun.file(path);
  if (!(await file.exists())) fail(`missing sample ${sample.file}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sample.kind === "image" && bytes.length > LIMITS.maxImageBytes) fail(`${sample.file} is over the image cap`);
  if (sample.kind === "audio" && bytes.length > LIMITS.maxAudioBytes) fail(`${sample.file} is over the audio cap`);
  if (sample.kind === "video" && bytes.length > LIMITS.maxVideoBytes) fail(`${sample.file} is over the video cap`);
  const sniffed = sniffMedia(bytes);
  if (!sniffed.ok) fail(`${sample.file} failed sniff: ${sniffed.message}`);
  if (sniffed.kind !== sample.kind) fail(`${sample.file} sniffed as ${sniffed.kind}, expected ${sample.kind}`);
  const validated = validateQuestions(preset.questions);
  if (!validated.ok) fail(`${preset.id}: ${validated.message}`);
  if (!preset.questions[0]?.options.includes(preset.expected)) fail(`${preset.id} expected label is not an option`);

  const row: PresetScore = {
    id: preset.id,
    sample: preset.sample,
    file: sample.file,
    question: preset.questions[0]!.instructions,
    expected: preset.expected,
    topLabel: null,
    expectedP: null,
    nextP: null,
    margin: null,
    confidence: null,
    latencyMs: null,
    source: live ? "clef-omni" : "skipped",
    ok: !live,
    note: live ? "" : "Workers AI was not called.",
  };

  if (live) {
    const result = await runOmni(bytes, sniffed.contentType, sample.kind, validated);
    const answer = result.answers[0];
    if (!answer) fail(`${preset.id}: no answer`);
    const expectedBar = answer.bars.find((bar) => bar.label === preset.expected);
    const others = answer.bars.filter((bar) => bar.label !== preset.expected).map((bar) => bar.probability);
    const nextP = others.length ? Math.max(...others) : 0;
    const expectedP = expectedBar?.probability ?? 0;
    row.topLabel = answer.topLabel;
    row.expectedP = expectedP;
    row.nextP = nextP;
    row.margin = expectedP - nextP;
    row.confidence = answer.confidence;
    row.latencyMs = result.latencyMs;
    const landed = answer.topLabel === preset.expected;
    const marginOk = row.margin >= minMargin;
    row.ok = landed && marginOk;
    row.note = landed
      ? marginOk
        ? `top ${answer.topLabel} ${Math.round(expectedP * 100)}% margin ${row.margin.toFixed(3)}`
        : `landed but margin ${row.margin.toFixed(3)} < ${minMargin}`
        : `wanted ${preset.expected}, got ${answer.topLabel}`;
  }

  scores.push(row);
  const line = `${row.ok ? "ok" : "FAIL"} ${row.id} ${row.note}`;
  if (row.ok) console.log(line);
  else {
    console.error(line, row);
    failed += 1;
  }
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify({ when: new Date().toISOString(), live, minMargin, scores }, null, 2)}\n`,
);
console.log(`wrote ${outFile}`);

if (failed) process.exit(1);
if (!live) console.log("preset files ok; live Clef-omni scores skipped");
else console.log("all presets landed with a clear margin");
