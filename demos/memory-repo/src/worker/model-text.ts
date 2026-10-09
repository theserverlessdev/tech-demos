export type ChatOutput = {
  choices?: { message?: { content?: string | null } }[];
  response?: string;
};

export function stripThinking(text: string): string {
  const end = text.lastIndexOf("</think>");
  const answer = end >= 0 ? text.slice(end + "</think>".length) : text;
  return answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

export function modelText(out: ChatOutput): string {
  const fromChoice = out.choices?.[0]?.message?.content;
  const raw = typeof fromChoice === "string" && fromChoice.trim() ? fromChoice : typeof out.response === "string" ? out.response : "";
  return stripThinking(raw);
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return JSON");
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

export function oneLine(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
