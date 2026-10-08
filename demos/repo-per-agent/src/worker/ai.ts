import { z } from "zod";
import type { DemoEnv } from "./env";
import { isEditablePath, type EditablePath } from "./files";

const EditSchema = z.object({
  path: z.string(),
  content: z.string().min(1).max(6000),
  message: z.string().min(1).max(72),
});

export type FileEdit = { path: EditablePath; content: string; message: string };

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

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return JSON");
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

export class ModelEditError extends Error {}

/** Ask Workers AI for one full-file replacement. Throws instead of inventing a commit. */
export async function proposeEdit(env: DemoEnv, instruction: string, files: Record<string, string>): Promise<FileEdit> {
  const payload = { instruction, files };
  let out: ChatOutput;
  try {
    // Workers AI types omit chat_template_kwargs; glm-5.3-flash otherwise spends the budget on a think block.
    out = (await env.AI.run(env.AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            'You edit one file in a tiny git repo. Reply with JSON only: {"path":"README.md"|"NOTES.md"|"src/task.ts","content":"the entire new file","message":"commit subject"}. content is the full file, not a diff. message is one line, at most 72 characters. Do not add other paths.',
        },
        { role: "user", content: JSON.stringify(payload) },
      ],
      max_tokens: 1800,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    } as never)) as ChatOutput;
  } catch (err) {
    throw new ModelEditError(`Workers AI request failed: ${err instanceof Error ? err.message : "unknown"}`);
  }

  let parsed: z.infer<typeof EditSchema>;
  try {
    parsed = EditSchema.parse(extractJson(modelText(out)));
  } catch (err) {
    throw new ModelEditError(`Workers AI returned an unusable edit: ${err instanceof Error ? err.message : "invalid"}`);
  }
  if (!isEditablePath(parsed.path)) throw new ModelEditError("Workers AI chose a path outside the task tree.");
  if (parsed.content.includes("\0")) throw new ModelEditError("Workers AI returned a binary file.");
  const message = parsed.message.replace(/\s+/g, " ").trim();
  if (!message) throw new ModelEditError("Workers AI returned an empty commit message.");
  return { path: parsed.path, content: parsed.content.endsWith("\n") ? parsed.content : `${parsed.content}\n`, message };
}
