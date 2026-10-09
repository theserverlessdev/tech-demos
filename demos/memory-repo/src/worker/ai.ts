import type { RecallHit } from "../shared/types";
import type { DreamNo, DreamOk } from "./dream";
import { parseDream } from "./dream";
import type { DemoEnv } from "./env";
import type { ParsedChat } from "./extract";
import { parseChatModel } from "./extract";
import { modelText, type ChatOutput } from "./model-text";

export class ModelError extends Error {}

async function complete(env: DemoEnv, system: string, user: string, maxTokens: number): Promise<string> {
  if (!env.AI) throw new ModelError("Workers AI is not configured");
  const run = env.AI.run.bind(env.AI) as (model: string, input: unknown) => Promise<ChatOutput>;
  let out: ChatOutput;
  try {
    out = await run(env.AI_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    });
  } catch (err) {
    throw new ModelError(err instanceof Error ? err.message : "Workers AI request failed");
  }
  const text = modelText(out);
  if (!text) throw new ModelError("Workers AI returned an empty response");
  return text;
}

const CHAT_SYSTEM = `You are the chat half of a memory agent. The person's long-term memory is markdown in a git repo.
Reply with JSON only:
{"reply":"what you say to the person","remember":[{"path":"people.md"|"preferences.md"|"projects.md","add":["one durable fact"]}],"summary":"one line about what you stored"}
remember is an empty array when the message has no durable fact, name, preference, or project.
Each add item is a short factual bullet in the person's words. Do not invent facts.
reply is plain sentences, under 80 words.`;

export async function completeChat(
  env: DemoEnv,
  input: { message: string; memoryIndex: string; recalled: RecallHit[] },
): Promise<ParsedChat> {
  const payload = {
    memoryIndex: input.memoryIndex.slice(0, 4000),
    recalled: input.recalled.slice(0, 5).map((hit) => ({ path: hit.path, snippet: hit.snippet.slice(0, 240) })),
    message: input.message,
  };
  const raw = await complete(env, CHAT_SYSTEM, JSON.stringify(payload), 700);
  const parsed = parseChatModel(raw);
  if (!parsed) throw new ModelError("Workers AI returned an unusable chat reply");
  return parsed;
}

const DREAM_SYSTEM = `You consolidate an agent's markdown memory. Merge duplicate bullets, drop lines that say nothing, and keep every distinct fact.
Reply with JSON only:
{"message":"dream: short subject","why":"one sentence","files":{"MEMORY.md":"full file","people.md":"full file","preferences.md":"full file","projects.md":"full file"}}
Return exactly those four files, each the full markdown document.
MEMORY.md must link to people.md, preferences.md, and projects.md.
Keep [source: ...] tags on facts you keep.
If nothing should change, return the files unchanged.`;

export async function completeDream(
  env: DemoEnv,
  input: { files: Record<string, string>; summaries: string[] },
  current: Record<string, string>,
): Promise<DreamOk | DreamNo> {
  const payload = {
    files: input.files,
    summaries: input.summaries.slice(0, 12),
  };
  const raw = await complete(env, DREAM_SYSTEM, JSON.stringify(payload), 2200);
  return parseDream(raw, current);
}
