import { LIMITS } from "../shared/limits";
import type { ChatMessage } from "../shared/types";
import { HttpError } from "./errors";
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

export async function runWorkersAi(
  env: Env,
  messages: ChatMessage[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<StreamStats & { source: string }> {
  const started = Date.now();
  const cap = Math.min(Math.max(maxTokens, LIMITS.maxTokensMin), LIMITS.compareMaxTokens);
  if (signal?.aborted) throw new HttpError(499, "cancelled", "Compare was cancelled.");
  if (!env.AI) {
    const stats = await consumeSse(stubStream(), [], started, signal);
    return { ...stats, source: "workers-ai-stub" };
  }
  try {
    const stream = (await env.AI.run(env.AI_MODEL, {
      messages,
      max_tokens: cap,
      temperature: 0.2,
      stream: true,
    })) as unknown as ReadableStream<Uint8Array>;
    const stats = await consumeSse(stream, [], started, signal);
    return { ...stats, source: env.AI_MODEL };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "workers_ai", "Workers AI failed.");
  }
}
