const RACE_TIMEOUT_MS = 6_000;
const CHAT_TIMEOUT_MS = 8_000;
const MIN_WAIT_MS = 300;

type ChatOutput = {
  choices?: { message?: { content?: string | null } }[];
  response?: string;
};

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ai_timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function stripThinking(text: string): string {
  const end = text.lastIndexOf("</think>");
  const answer = end >= 0 ? text.slice(end + "</think>".length) : text;
  return answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

function modelText(out: ChatOutput): string {
  const fromChoice = out.choices?.[0]?.message?.content;
  const raw = typeof fromChoice === "string" && fromChoice.trim() ? fromChoice : typeof out.response === "string" ? out.response : "";
  return stripThinking(raw).replace(/\s+/g, " ").trim();
}

/**
 * The race waits here on purpose. Workers AI is not storage, so the input gate
 * opens and other requests on this actor can run. A short pad keeps the bar
 * visible when the model returns immediately. Fallback is a timed wait with
 * the same shape, labelled so the UI does not pretend the model answered.
 */
export async function awaitModel(env: Env): Promise<"workers-ai" | "fallback-delay"> {
  const started = Date.now();
  let source: "workers-ai" | "fallback-delay" = "workers-ai";
  try {
    if (!env.AI) throw new Error("ai_binding_missing");
    await withTimeout(
      env.AI.run(env.AI_MODEL, {
        messages: [
          { role: "system", content: "Reply with exactly one word: ready" },
          { role: "user", content: "ready?" },
        ],
        max_tokens: 8,
        temperature: 0,
      }),
      RACE_TIMEOUT_MS,
    );
  } catch (err) {
    source = "fallback-delay";
    console.error(JSON.stringify({ event: "race_ai_fallback", error: String(err) }));
  }
  const elapsed = Date.now() - started;
  if (elapsed < MIN_WAIT_MS) await scheduler.wait(MIN_WAIT_MS - elapsed);
  return source;
}

export async function actorReply(
  env: Env,
  transcript: { name: string; role: string; text: string }[],
): Promise<{ text: string; source: "workers-ai" | "fallback" }> {
  const lines = transcript.slice(-8).map((message) => `${message.role}:${message.name}: ${message.text}`);
  try {
    if (!env.AI) throw new Error("ai_binding_missing");
    const out = (await withTimeout(
      env.AI.run(env.AI_MODEL, {
        messages: [
          {
            role: "system",
            content:
              "You are the room actor in a short technical demo about Durable Objects. Reply in one or two sentences. Do not invent citations or claim you ran a tool.",
          },
          { role: "user", content: lines.join("\n") },
        ],
        max_tokens: 80,
        temperature: 0.4,
      }),
      CHAT_TIMEOUT_MS,
    )) as ChatOutput;
    const text = modelText(out);
    if (text.length >= 2 && text.length <= 400) return { text, source: "workers-ai" };
  } catch (err) {
    console.error(JSON.stringify({ event: "chat_ai_fallback", error: String(err) }));
  }
  return {
    text: "I stored that in SQLite, but Workers AI did not answer this turn.",
    source: "fallback",
  };
}
