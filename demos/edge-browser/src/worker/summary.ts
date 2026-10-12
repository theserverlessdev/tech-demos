import { LIMITS } from "../shared/limits";

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

export function excerptSummary(markdown: string, local: boolean): string {
  const body = markdown.replace(/\s+/g, " ").trim().slice(0, 400);
  const prefix = local ? "Local dev has no Workers AI session. Excerpt: " : "Workers AI did not return a summary. Excerpt: ";
  return `${prefix}${body || "The page had no text."}`;
}

export async function summarize(env: Env, markdown: string): Promise<{ text: string; source: "workers-ai" | "excerpt" }> {
  const environment: string = env.ENVIRONMENT;
  if (environment === "local" || !env.AI) return { text: excerptSummary(markdown, environment === "local"), source: "excerpt" };
  try {
    const run = env.AI.run.bind(env.AI) as (model: string, input: unknown) => Promise<ChatOutput>;
    const out = await run(env.AI_MODEL, {
      messages: [
        {
          role: "system",
          content: "Summarize the page in 2 or 3 sentences for a person who has not opened it. Use only the markdown. Do not invent facts. Plain text, under 80 words.",
        },
        { role: "user", content: markdown.slice(0, LIMITS.summaryInputChars) },
      ],
      max_tokens: LIMITS.summaryMaxTokens,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    });
    const text = modelText(out).replace(/\s+/g, " ").trim().slice(0, 800);
    if (!text) return { text: excerptSummary(markdown, false), source: "excerpt" };
    return { text, source: "workers-ai" };
  } catch (err) {
    console.error(JSON.stringify({ event: "summary_failed", error: String(err).slice(0, 200) }));
    return { text: excerptSummary(markdown, false), source: "excerpt" };
  }
}
