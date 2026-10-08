import { normalize } from "./memory";

type ChatOutput = {
  choices?: { message?: { content?: string | null } }[];
  response?: string;
};

function stripThinking(text: string): string {
  const end = text.lastIndexOf("</think>");
  const answer = end >= 0 ? text.slice(end + "</think>".length) : text;
  return answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

function modelText(out: ChatOutput): string {
  const fromChoice = out.choices?.[0]?.message?.content;
  const raw = typeof fromChoice === "string" && fromChoice.trim() ? fromChoice : typeof out.response === "string" ? out.response : "";
  return stripThinking(raw);
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}

// The generated Workers AI model union does not include the model name stored in wrangler vars.
async function runModel(env: Env, model: string, input: Record<string, unknown>): Promise<unknown> {
  const ai = env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  return ai.run(model, input);
}

export async function embedTexts(env: Env, texts: string[]): Promise<Float32Array[] | null> {
  try {
    const out = (await runModel(env, env.EMBED_MODEL, {
      text: texts.map((text) => text.slice(0, 1000)),
    })) as { data?: number[][] };
    const data = out.data ?? [];
    if (data.length !== texts.length || data.some((row) => row.length < 8)) return null;
    return data.map((row) => normalize(Float32Array.from(row)));
  } catch (err) {
    console.error(JSON.stringify({ event: "embed_failed", error: errName(err) }));
    return null;
  }
}

export async function complete(env: Env, system: string, user: string): Promise<string | null> {
  try {
    const out = (await runModel(env, env.AI_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user.slice(0, 12_000) },
      ],
      max_tokens: 500,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    })) as ChatOutput;
    const text = modelText(out);
    if (text.length < 2 || text.length > 4_000) return null;
    return text;
  } catch (err) {
    console.error(JSON.stringify({ event: "chat_failed", error: errName(err) }));
    return null;
  }
}
