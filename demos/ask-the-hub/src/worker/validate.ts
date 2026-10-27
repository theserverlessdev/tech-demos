export const QUESTION_MAX = 500;

export type QuestionResult = { ok: true; question: string } | { ok: false; error: string };

export function parseQuestion(body: unknown): QuestionResult {
  if (!body || typeof body !== "object") return { ok: false, error: "Send a question." };
  const raw = (body as { question?: unknown }).question;
  if (typeof raw !== "string") return { ok: false, error: "Send a question." };
  const question = raw.trim();
  if (!question) return { ok: false, error: "Send a question." };
  if (question.length > QUESTION_MAX) return { ok: false, error: "Keep the question to 500 characters." };
  return { ok: true, question };
}

export function readToken(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const token = (body as { turnstileToken?: unknown }).turnstileToken;
  return typeof token === "string" ? token : "";
}
