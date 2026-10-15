import { z } from "zod";
import type { DemoEnv } from "./env";
import { EDITABLE_PATHS, isEditablePath, type EditablePath } from "./files";

const EditSchema = z.object({
  path: z.string(),
  content: z.string().min(1).max(6000),
  message: z.string().min(1).max(72),
});

export type FileEdit = { path: EditablePath; content: string; message: string };

export const EDIT_JSON_SCHEMA = {
  name: "file_edit",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content", "message"],
    properties: {
      path: { type: "string", enum: [...EDITABLE_PATHS] },
      content: { type: "string", minLength: 1, maxLength: 6000 },
      message: { type: "string", minLength: 1, maxLength: 72 },
    },
  },
} as const;

/** GLM-5.3-flash: reasoning cannot be disabled; default is max. low + 4096 leaves room for a full-file body. */
export const MODEL_OPTIONS = {
  max_tokens: 4096,
  temperature: 0.2,
  reasoning_effort: "low" as const,
  response_format: { type: "json_schema" as const, json_schema: EDIT_JSON_SCHEMA },
};

export const SYSTEM_PROMPT =
  'You edit one file in a tiny git repo. Reply with JSON only: {"path":"README.md"|"NOTES.md"|"src/task.ts","content":"the entire new file","message":"commit subject"}. content is the full file, not a diff. message is one line, at most 72 characters. Do not add other paths.';

export type ChatOutput = {
  choices?: { finish_reason?: string | null; message?: { content?: string | null } }[];
  response?: string;
};

export function buildModelInput(instruction: string, files: Record<string, string>) {
  return {
    messages: [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: JSON.stringify({ instruction, files }) },
    ],
    ...MODEL_OPTIONS,
  };
}

function stripThinking(text: string): string {
  const end = text.lastIndexOf("</think>");
  const answer = end >= 0 ? text.slice(end + "</think>".length) : text;
  return answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

export function modelExhausted(out: ChatOutput): boolean {
  const choice = out.choices?.[0];
  if (choice?.finish_reason === "length") return true;
  const content = choice?.message?.content;
  if (content === null) return true;
  return false;
}

export function modelText(out: ChatOutput): string {
  if (modelExhausted(out)) throw new ModelEditError("the model ran out of tokens");
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
  const input = buildModelInput(instruction, files);
  let out: ChatOutput;
  try {
    out = (await env.AI.run(env.AI_MODEL, input as never)) as ChatOutput;
  } catch (err) {
    throw new ModelEditError(`Workers AI request failed: ${err instanceof Error ? err.message : "unknown"}`);
  }

  let parsed: z.infer<typeof EditSchema>;
  try {
    parsed = EditSchema.parse(extractJson(modelText(out)));
  } catch (err) {
    const detail = err instanceof ModelEditError ? err.message : err instanceof Error ? err.message : "invalid";
    throw new ModelEditError(`Workers AI returned an unusable edit: ${detail}`);
  }
  if (!isEditablePath(parsed.path)) throw new ModelEditError("Workers AI chose a path outside the task tree.");
  if (parsed.content.includes("\0")) throw new ModelEditError("Workers AI returned a binary file.");
  const message = parsed.message.replace(/\s+/g, " ").trim();
  if (!message) throw new ModelEditError("Workers AI returned an empty commit message.");
  return { path: parsed.path, content: parsed.content.endsWith("\n") ? parsed.content : `${parsed.content}\n`, message };
}
