import { LIMITS } from "../shared/limits";
import type { DraftResult, TicketDetail } from "../shared/types";

type ChatOutput = {
  choices?: { finish_reason?: string | null; message?: { content?: string | null } }[];
  response?: string;
};

function stripThinking(text: string): string {
  const end = text.lastIndexOf("</think>");
  const answer = end >= 0 ? text.slice(end + "</think>".length) : text;
  return answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

export function normalizeDraft(text: string): string {
  let out = stripThinking(text).replace(/^["'`]+|["'`]+$/g, "").trim();
  out = out.replace(/^\s*subject:\s*.+\n+/i, "");
  out = out.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s+/gm, "");
  return out.trim();
}

function modelText(out: ChatOutput): { text: string; finishReason: string | null } {
  const choice = out.choices?.[0];
  const fromChoice = choice?.message?.content;
  const raw = typeof fromChoice === "string" && fromChoice.trim() ? fromChoice : typeof out.response === "string" ? out.response : "";
  return { text: normalizeDraft(raw), finishReason: choice?.finish_reason ?? null };
}

export function usableDraft(text: string): boolean {
  if (!/^(hi|hello|dear|hey)[\s,]/i.test(text)) return false;
  if (text.length < 40 || text.length > 900) return false;
  if (/what facts|i cannot promise|now i need|constraints:|ticket json|output only|customer-facing email/i.test(text)) {
    return false;
  }
  return true;
}

function fallbackDraft(ticket: TicketDetail): string {
  const first = ticket.customerName.split(/\s+/)[0] || "there";
  const who = ticket.assignee ?? "Support";
  return `Hi ${first},\n\nThanks for writing in about ${ticket.subject}. I've read the thread and will follow up with a concrete next step instead of guessing at refunds or timelines. If you have a reference ID or screenshot that is not already attached, send it on this ticket.\n\n${who}`;
}

function boundPrompt(ticket: TicketDetail) {
  return {
    number: ticket.number,
    subject: ticket.subject.slice(0, LIMITS.draftSubjectChars),
    customer: `${ticket.customerName} <${ticket.customerEmail}>`,
    status: ticket.status,
    priority: ticket.priority,
    assignee: ticket.assignee,
    messages: ticket.messages.slice(-LIMITS.draftMessageCount).map((m) => ({
      from: `${m.authorKind}:${m.authorName}`,
      body: m.body.slice(0, LIMITS.draftMessageChars),
    })),
  };
}

export async function draftReply(env: Env, ticket: TicketDetail): Promise<DraftResult> {
  const payload = boundPrompt(ticket);
  const first = ticket.customerName.split(/\s+/)[0] || "there";
  if (!env.AI) {
    return { draft: fallbackDraft(ticket), model: env.AI_MODEL, source: "fallback", finishReason: "no_binding" };
  }

  try {
    const out = (await env.AI.run(env.AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are a support agent. Write one customer-facing email body as the named assignee when present. Return only that body. 80–140 words. Do not invent refunds, dates, or causes. If a fact is missing, ask one question.",
        },
        { role: "user", content: `Ticket JSON:\n${JSON.stringify(payload)}\n\nWrite the email body now. Start with "Hi ${first},"` },
      ],
      max_tokens: LIMITS.maxTokens,
      max_completion_tokens: LIMITS.maxTokens,
      temperature: 0.3,
      reasoning_effort: "low",
    } as never)) as ChatOutput;
    const generated = modelText(out);
    if (usableDraft(generated.text)) {
      return { draft: generated.text, model: env.AI_MODEL, source: "workers-ai", finishReason: generated.finishReason };
    }
    console.warn(JSON.stringify({ event: "ai_draft_unusable", finishReason: generated.finishReason, chars: generated.text.length }));
  } catch (err) {
    console.error(JSON.stringify({ event: "ai_draft_failed", error: String(err) }));
  }
  return { draft: fallbackDraft(ticket), model: env.AI_MODEL, source: "fallback", finishReason: null };
}
