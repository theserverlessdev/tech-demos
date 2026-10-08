import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { LIMITS, type SplitStep } from "../shared/types";
import { updateSplit, writeSubtasks, type SubtaskDraft } from "./db";
import { notifyBoard } from "./board";

type Params = { boardId: string; taskId: string; splitId: string };

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

function parseSubtasks(text: string): SubtaskDraft[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 3 || parsed.length > 6) return null;
  const drafts: SubtaskDraft[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") return null;
    const title = (item as { title?: unknown }).title;
    const description = (item as { description?: unknown }).description;
    if (typeof title !== "string" || !title.trim() || title.trim().length > LIMITS.maxTitle) return null;
    const body = typeof description === "string" ? description.trim().slice(0, 400) : "";
    drafts.push({ title: title.trim(), description: body });
  }
  return drafts;
}

function fallbackSubtasks(title: string): SubtaskDraft[] {
  const subject = (title.trim() || "this card").slice(0, 60);
  return [
    { title: `Clarify “${subject}”`, description: "Write the outcome in one sentence and what would make the card done." },
    { title: "Do the first slice", description: "Finish the smallest piece that can be checked, and leave the rest named." },
    { title: "Check the result", description: "Compare the slice with the outcome and note what is still missing." },
    { title: "Leave the next step", description: "Name the following action so the card can move to Done or stay in Doing." },
  ];
}

async function record(env: Env, splitId: string, steps: SplitStep[], extra: { status?: string; source?: string; error?: string | null } = {}): Promise<SplitStep[]> {
  await updateSplit(env, splitId, { steps, ...extra });
  return steps;
}

export class SplitTaskWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<{ written: number; source: string }> {
    // Replay restores step return values; anything the next step needs has to be returned.
    const loaded = await step.do("load task", async () => {
      const { boardId, taskId, splitId } = event.payload;
      const row = await this.env.DB.prepare(`SELECT title, description FROM tasks WHERE id = ? AND board_id = ?`).bind(taskId, boardId).first<{ title: string; description: string }>();
      if (!row) {
        await updateSplit(this.env, splitId, { status: "errored", error: "The card is gone." });
        throw new NonRetryableError("task missing");
      }
      const steps = await record(this.env, splitId, [{ name: "load task", at: Date.now() }], { status: "running" });
      return { title: row.title, description: row.description, steps };
    });

    const drafted = await step.do(
      "ask workers ai",
      { timeout: "25 seconds", retries: { limit: 1, delay: "1 second", backoff: "constant" } },
      async () => {
        const steps: SplitStep[] = [...loaded.steps, { name: "ask workers ai", at: Date.now() }];
        let subtasks = fallbackSubtasks(loaded.title);
        let source = "fallback";
        try {
          // `as never`: the Workers AI model union does not list this chat payload.
          const out = (await this.env.AI.run(this.env.AI_MODEL, {
            messages: [
              {
                role: "system",
                content:
                  "Split one kanban card into concrete subtasks. Return only a JSON array of 4 objects with keys title and description. Titles under 80 characters. No markdown.",
              },
              { role: "user", content: `Title: ${loaded.title}\nDescription: ${loaded.description || "(none)"}` },
            ],
            max_tokens: 600,
            temperature: 0.2,
            chat_template_kwargs: { enable_thinking: false },
          } as never)) as ChatOutput;
          const parsed = parseSubtasks(modelText(out));
          if (parsed) {
            subtasks = parsed;
            source = "workers-ai";
          }
        } catch (err) {
          console.error(JSON.stringify({ event: "ai_split_failed", error: String(err) }));
        }
        await record(this.env, event.payload.splitId, steps, { source, status: "running" });
        return { subtasks, source, steps };
      },
    );

    const written = await step.do("write subtasks", async () => {
      const { boardId, taskId, splitId } = event.payload;
      const count = await writeSubtasks(this.env, boardId, taskId, splitId, drafted.subtasks);
      const steps: SplitStep[] = [...drafted.steps, { name: "write subtasks", at: Date.now() }];
      await record(this.env, splitId, steps, { status: "complete", source: drafted.source, error: null });
      await notifyBoard(this.env, boardId, "snapshot");
      return { written: count, source: drafted.source };
    });

    return written;
  }
}
