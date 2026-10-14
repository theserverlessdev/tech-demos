import { LIMITS } from "../shared/limits";
import type { ChatMessage } from "../shared/types";
import { readCappedBytes, rejectOversizedContentLength } from "./bytes";
import { HttpError } from "./errors";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  rejectOversizedContentLength(request.headers, LIMITS.requestBytes, "The request body is too large.");
  const bytes = await readCappedBytes(request.body, LIMITS.requestBytes);
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error("shape");
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "invalid_json", "The request body must be a JSON object.");
  }
}

export function parseModel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "model", "Enter a model id.");
  const model = value.trim();
  if (model.length > LIMITS.maxModelChars) throw new HttpError(400, "model", "That model id is too long.");
  if (/[\r\n]/.test(model)) throw new HttpError(400, "model", "That model id is not allowed.");
  return model;
}

export function parseTemperature(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0.4;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new HttpError(400, "temperature", "Temperature must be between 0 and 2.");
  return n;
}

export function parseMaxTokens(value: unknown, cap: number = LIMITS.maxTokensMax): number {
  if (value === undefined || value === null || value === "") return Math.min(LIMITS.maxTokensDefault, cap);
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < LIMITS.maxTokensMin || n > cap) {
    throw new HttpError(400, "max_tokens", `Max tokens must be between ${LIMITS.maxTokensMin} and ${cap}.`);
  }
  return n;
}

export function parseSystem(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(400, "system", "System prompt must be text.");
  if (value.length > LIMITS.maxSystemChars) throw new HttpError(400, "system", "System prompt is too long.");
  return value;
}

export function parseMessages(value: unknown, system: string): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, "messages", "Add at least one message.");
  if (value.length > LIMITS.maxMessages) throw new HttpError(400, "messages", "Too many messages.");
  const messages: ChatMessage[] = [];
  if (system.trim()) messages.push({ role: "system", content: system });
  for (const item of value) {
    if (!isRecord(item)) throw new HttpError(400, "messages", "Each message must be an object.");
    const role = item.role;
    const content = item.content;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new HttpError(400, "messages", "Message role must be user, assistant, or system.");
    }
    if (typeof content !== "string" || !content.trim()) throw new HttpError(400, "messages", "Message content must be text.");
    if (content.length > LIMITS.maxMessageChars) throw new HttpError(400, "messages", "A message is too long.");
    messages.push({ role, content: content.slice(0, LIMITS.maxMessageChars) });
  }
  return messages;
}

export function promptFrom(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === "user");
  return last?.content ?? "";
}
