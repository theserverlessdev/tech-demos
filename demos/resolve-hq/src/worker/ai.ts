import type { DraftResult, TicketDetail } from "../shared/types";

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
  return stripThinking(raw).replace(/^["'`]+|["'`]+$/g, "").trim();
}

function usableDraft(text: string): boolean {
  if (!/^hi[\s,]/i.test(text)) return false;
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

export async function draftReply(env: Env, ticket: TicketDetail): Promise<DraftResult> {
  const payload = {
    number: ticket.number,
    subject: ticket.subject,
    customer: `${ticket.customerName} <${ticket.customerEmail}>`,
    status: ticket.status,
    priority: ticket.priority,
    assignee: ticket.assignee,
    messages: ticket.messages.slice(-8).map((m) => ({
      from: `${m.authorKind}:${m.authorName}`,
      body: m.body,
    })),
  };

  try {
    const out = (await env.AI.run(env.AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are a support agent. Write one customer-facing email body as the named assignee when present. Return only that body. 80–140 words. Do not invent refunds, dates, or causes. If a fact is missing, ask one question.",
        },
        { role: "user", content: `Ticket JSON:\n${JSON.stringify(payload)}\n\nWrite the email body now. Start with "Hi ${ticket.customerName.split(" ")[0]},"` },
      ],
      max_tokens: 400,
      temperature: 0.3,
      chat_template_kwargs: { enable_thinking: false },
    } as never)) as ChatOutput;
    const generated = modelText(out);
    if (usableDraft(generated)) return { draft: generated, model: env.AI_MODEL, source: "workers-ai" };
  } catch (err) {
    console.error(JSON.stringify({ event: "ai_draft_failed", error: String(err) }));
  }
  return { draft: fallbackDraft(ticket), model: env.AI_MODEL, source: "fallback" };
}
