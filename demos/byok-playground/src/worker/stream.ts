import { LIMITS } from "../shared/limits";
import { HttpError } from "./errors";
import { redact } from "./redact";

export type StreamStats = {
  text: string;
  ttftMs: number | null;
  tokens: number | null;
  latencyMs: number;
};

function contentFromJson(parsed: unknown): { text: string; tokens: number | null } {
  if (!parsed || typeof parsed !== "object") return { text: "", tokens: null };
  const row = parsed as {
    choices?: { delta?: { content?: string }; message?: { content?: string } }[];
    usage?: { completion_tokens?: number; total_tokens?: number };
    response?: string;
    result?: { response?: string };
  };
  const delta = row.choices?.[0]?.delta?.content;
  const message = row.choices?.[0]?.message?.content;
  const response = typeof row.response === "string" ? row.response : typeof row.result?.response === "string" ? row.result.response : "";
  const text = typeof delta === "string" ? delta : typeof message === "string" ? message : response;
  const tokens = typeof row.usage?.completion_tokens === "number" ? row.usage.completion_tokens : typeof row.usage?.total_tokens === "number" ? row.usage.total_tokens : null;
  return { text, tokens };
}

function takeLine(line: string, secrets: readonly string[], acc: StreamStats, started: number): void {
  const cleaned = redact(line, secrets);
  const trimmed = cleaned.trim();
  if (!trimmed || trimmed === "data: [DONE]") return;
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  try {
    const parsed = JSON.parse(payload) as unknown;
    const piece = contentFromJson(parsed);
    if (piece.text) {
      if (acc.ttftMs === null) acc.ttftMs = Date.now() - started;
      acc.text += piece.text;
    }
    if (piece.tokens !== null) acc.tokens = piece.tokens;
  } catch {
    /* ignore keepalives */
  }
}

/** Parse OpenAI-style SSE into text + TTFT. Caps total bytes and a carry without a newline. */
export async function consumeSse(
  stream: ReadableStream<Uint8Array> | null,
  secrets: readonly string[],
  started: number,
  signal?: AbortSignal,
): Promise<StreamStats> {
  const acc: StreamStats = { text: "", ttftMs: null, tokens: null, latencyMs: 0 };
  if (!stream) {
    acc.latencyMs = Date.now() - started;
    return acc;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let seen = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(499, "cancelled", "The stream was cancelled.");
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += chunk.value.byteLength;
      if (seen > LIMITS.sseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, "too_large", "The endpoint stream was too large.");
      }
      carry += decoder.decode(chunk.value, { stream: true });
      if (carry.length > LIMITS.sseCarryBytes && !/[\r\n]/.test(carry)) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, "too_large", "The endpoint sent a line that was too long.");
      }
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) takeLine(line, secrets, acc, started);
    }
    carry += decoder.decode();
    if (carry) takeLine(carry, secrets, acc, started);
  } finally {
    acc.latencyMs = Date.now() - started;
  }
  acc.text = redact(acc.text, secrets);
  return acc;
}

export function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
