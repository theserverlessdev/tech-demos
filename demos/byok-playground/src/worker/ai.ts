import { LIMITS } from "../shared/limits";
import type { ChatMessage } from "../shared/types";
import type { DemoEnv } from "./env";
import { consumeSse, type StreamStats } from "./stream";

const STUB_TEXT = "Workers AI is stubbed in local wrangler. This labelled reply is not a model.";

function stubStream(): ReadableStream<Uint8Array> {
  const words = STUB_TEXT.split(" ");
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= words.length) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const token = (i === 0 ? "" : " ") + words[i];
      i += 1;
      const payload = JSON.stringify({ choices: [{ delta: { content: token } }] });
      controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
    },
  });
}

export async function runWorkersAi(env: DemoEnv, messages: ChatMessage[], maxTokens: number): Promise<StreamStats & { source: string }> {
  const started = Date.now();
  const cap = Math.min(Math.max(maxTokens, LIMITS.maxTokensMin), LIMITS.compareMaxTokens);
  if (!env.AI) {
    const stats = await consumeSse(stubStream(), [], started);
    return { ...stats, source: "workers-ai-stub" };
  }
  try {
    const stream = (await env.AI.run(env.AI_MODEL, {
      messages,
      max_tokens: cap,
      temperature: 0.2,
      stream: true,
    })) as unknown as ReadableStream<Uint8Array>;
    const stats = await consumeSse(stream, [], started);
    return { ...stats, source: env.AI_MODEL };
  } catch {
    const out = (await env.AI.run(env.AI_MODEL, {
      messages,
      max_tokens: cap,
      temperature: 0.2,
    })) as { response?: string; choices?: { message?: { content?: string } }[] };
    const text = typeof out.response === "string" ? out.response : (out.choices?.[0]?.message?.content ?? "");
    return {
      text: text.trim(),
      ttftMs: Date.now() - started,
      tokens: null,
      latencyMs: Date.now() - started,
      source: env.AI_MODEL,
    };
  }
}
