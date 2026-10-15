import { LIMITS } from "../shared/limits";
import { redactExact } from "../shared/text";
import { classifyReadTimeout, readWithIdle } from "./bytes";
import { HttpError } from "./errors";

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
  const cleaned = redactExact(line, secrets);
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

/** Split a buffer into complete SSE events (blank-line terminated) and the leftover carry. */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  while (true) {
    const idxN = rest.indexOf("\n\n");
    const idxR = rest.indexOf("\r\n\r\n");
    let idx = -1;
    let sep = 2;
    if (idxR !== -1 && (idxN === -1 || idxR <= idxN)) {
      idx = idxR;
      sep = 4;
    } else if (idxN !== -1) {
      idx = idxN;
      sep = 2;
    }
    if (idx === -1) break;
    events.push(rest.slice(0, idx + sep));
    rest = rest.slice(idx + sep);
  }
  return { events, rest };
}

/** Complete SSE lines (including CR-only) when the upstream never emits a blank event separator. */
export function splitCompleteSseLines(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  while (rest.length) {
    const idxN = rest.indexOf("\n");
    const idxR = rest.indexOf("\r");
    let idx = -1;
    let sep = 1;
    if (idxN === -1 && idxR === -1) break;
    if (idxR !== -1 && (idxN === -1 || idxR < idxN)) {
      idx = idxR;
      sep = rest[idxR + 1] === "\n" ? 2 : 1;
    } else {
      idx = idxN;
      sep = 1;
    }
    events.push(rest.slice(0, idx + sep));
    rest = rest.slice(idx + sep);
  }
  return { events, rest };
}

export type ConsumeSseOptions = {
  idleMs?: number;
  overallMs?: number;
  signal?: AbortSignal;
};

/** Parse OpenAI-style SSE into text + TTFT. Caps total bytes and a carry without a newline. Idle + overall timeouts. */
export async function consumeSse(
  stream: ReadableStream<Uint8Array> | null,
  secrets: readonly string[],
  started: number,
  signalOrOptions?: AbortSignal | ConsumeSseOptions,
): Promise<StreamStats> {
  const options: ConsumeSseOptions = signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions } : (signalOrOptions ?? {});
  const acc: StreamStats = { text: "", ttftMs: null, tokens: null, latencyMs: 0 };
  if (!stream) {
    acc.latencyMs = Date.now() - started;
    return acc;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let seen = 0;
  const idleMs = options.idleMs ?? LIMITS.idleTimeoutMs;
  const overallMs = options.overallMs ?? LIMITS.overallTimeoutMs;
  try {
    while (true) {
      if (options.signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(499, "cancelled", "The stream was cancelled.");
      }
      const remaining = overallMs - (Date.now() - started);
      if (remaining <= 0) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(504, "timeout", "The stream reached the overall time cap.");
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      const wait = Math.min(idleMs, remaining);
      try {
        chunk = await readWithIdle(reader, wait, options.signal);
      } catch (err) {
        await reader.cancel().catch(() => undefined);
        const classified = classifyReadTimeout(err, wait, idleMs);
        const message = classified.message;
        if (message === "cancelled") throw new HttpError(499, "cancelled", "The stream was cancelled.");
        if (message === "idle") throw new HttpError(504, "timeout", "The endpoint timed out waiting for the next chunk.");
        if (message === "overall") throw new HttpError(504, "timeout", "The stream reached the overall time cap.");
        throw new HttpError(502, "upstream", "The endpoint connection was lost.");
      }
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
  acc.text = redactExact(acc.text, secrets);
  return acc;
}

export function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function classifyStreamError(err: unknown): { socket: boolean; overall: boolean; idle: boolean; message: string } {
  const message = err instanceof Error ? err.message : "socket";
  if (message === "idle") return { socket: false, overall: false, idle: true, message: "The endpoint timed out waiting for the next chunk." };
  if (message === "cancelled") return { socket: false, overall: false, idle: false, message: "The stream was cancelled." };
  if (message === "overall") return { socket: false, overall: true, idle: false, message: "The stream reached the overall time cap." };
  return { socket: true, overall: false, idle: false, message: "The endpoint connection was lost." };
}

