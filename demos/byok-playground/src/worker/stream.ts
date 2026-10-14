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

/** Parse OpenAI-style SSE (and Workers AI JSON chunks) into text + TTFT. */
export async function consumeSse(stream: ReadableStream<Uint8Array> | null, secrets: readonly string[], started: number): Promise<StreamStats> {
  if (!stream) return { text: "", ttftMs: null, tokens: null, latencyMs: Date.now() - started };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let text = "";
  let ttftMs: number | null = null;
  let tokens: number | null = null;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    carry += decoder.decode(chunk.value, { stream: true });
    carry = redact(carry, secrets);
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      try {
        const parsed = JSON.parse(payload) as unknown;
        const piece = contentFromJson(parsed);
        if (piece.text) {
          if (ttftMs === null) ttftMs = Date.now() - started;
          text += piece.text;
        }
        if (piece.tokens !== null) tokens = piece.tokens;
      } catch {
        /* ignore keepalives */
      }
    }
  }
  return { text: redact(text, secrets), ttftMs, tokens, latencyMs: Date.now() - started };
}

export function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
