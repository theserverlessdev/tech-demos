import { buildOmniRequest, omniCost, parseOmniResponse, stubAnswers, type OmniMedia } from "../shared/clef";
import type { ChoiceQuestion, JudgmentResult } from "../shared/types";
import { environmentName } from "./turnstile";

type ModelRun = (model: string, input: unknown) => Promise<unknown>;

export async function runModel(env: Env, model: string, input: unknown): Promise<unknown> {
  const run = env.AI.run.bind(env.AI) as unknown as ModelRun;
  return run(model, input);
}

export async function runOmni(env: Env, media: OmniMedia, questions: ChoiceQuestion[], seed: string, sampleId?: string | null): Promise<{ ok: true; result: JudgmentResult } | { ok: false; message: string }> {
  if (environmentName(env) === "local") {
    const started = Date.now();
    const answers = stubAnswers(questions, seed, sampleId);
    const result: JudgmentResult = {
      answers,
      latencyMs: Math.max(1, Date.now() - started),
      model: env.OMNI_MODEL,
      source: "local-stub",
      cost: { usd: null, note: "Local stub. Workers AI was not called." },
      untrustedText: null,
      steps: [],
    };
    return { ok: true, result };
  }
  const started = Date.now();
  let raw: unknown;
  try {
    raw = await runModel(env, env.OMNI_MODEL, buildOmniRequest(media, questions));
  } catch (err) {
    console.error(JSON.stringify({ event: "omni_failed", error: err instanceof Error ? err.name : "error" }));
    return { ok: false, message: "Workers AI did not answer." };
  }
  const parsed = parseOmniResponse(raw, questions);
  if (!parsed) return { ok: false, message: "The model response could not be read." };
  const cost = omniCost(parsed.inputTokens, media);
  return {
    ok: true,
    result: {
      answers: parsed.answers,
      latencyMs: Math.max(1, Date.now() - started),
      model: env.OMNI_MODEL,
      source: "clef-omni",
      cost,
      untrustedText: null,
      steps: [],
    },
  };
}
