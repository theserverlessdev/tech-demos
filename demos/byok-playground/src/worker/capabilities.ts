import type { CapabilityResult, ChatMessage } from "../shared/types";
import { LIMITS } from "../shared/limits";
import { HttpError } from "./errors";
import { isRecord } from "./parse";
import { failFromUpstream, proxyFetch, readCappedText, requireUpstreamType } from "./proxy";
import { redact } from "./redact";
import { consumeSse } from "./stream";

/** 1×1 red PNG. The vision probe asks for this colour. */
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function classify(raw: string, status: number): CapabilityResult["status"] {
  const text = raw.toLowerCase();
  if (status === 404 || status === 405) return "unsupported";
  if (/(not support|unsupported|unknown parameter|unrecognized|invalid parameter|response_format|does not exist|no such|not enabled|not available)/i.test(text)) {
    return "unsupported";
  }
  if (status >= 200 && status < 300) return "inconclusive";
  return "fail";
}

function messageContent(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return "";
    const first = parsed.choices[0];
    if (!isRecord(first) || !isRecord(first.message)) return "";
    return typeof first.message.content === "string" ? first.message.content : "";
  } catch {
    return "";
  }
}

export function hasToolCalls(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return false;
    const first = parsed.choices[0];
    if (!isRecord(first) || !isRecord(first.message)) return false;
    return Array.isArray(first.message.tool_calls) && first.message.tool_calls.length > 0;
  } catch {
    return false;
  }
}

export function jsonSchemaOk(text: string): boolean | null {
  const content = messageContent(text);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || typeof parsed.ok !== "boolean") return null;
    return true;
  } catch {
    return null;
  }
}

export function visionNamesRed(text: string): boolean {
  return /\bred\b/i.test(messageContent(text) || text);
}

async function probe(
  name: CapabilityResult["name"],
  url: string,
  apiKey: string,
  body: unknown,
  check: (status: number, text: string) => { status: CapabilityResult["status"]; detail: string },
): Promise<CapabilityResult> {
  const secrets = [apiKey];
  const started = Date.now();
  try {
    const upstream = await proxyFetch({
      url,
      method: "POST",
      apiKey,
      body: JSON.stringify(body),
      accept: "application/json",
      timeoutMs: 12_000,
    });
    const text = await readCappedText(upstream, secrets, LIMITS.probeBytes);
    if (upstream.status >= 400) {
      const err = failFromUpstream(upstream.status, text, secrets);
      const classified = classify(err.message, upstream.status);
      return { name, status: classified, detail: classified === "unsupported" ? "The endpoint rejected this parameter." : "The endpoint returned an error.", raw: redact(err.message, secrets).slice(0, 500), latencyMs: Date.now() - started };
    }
    const result = check(upstream.status, text);
    return { name, status: result.status, detail: result.detail, raw: redact(text, secrets).slice(0, 500), latencyMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof HttpError ? err.message : "The probe failed.";
    const status = err instanceof HttpError ? err.status : 502;
    const classified = classify(message, status);
    return { name, status: classified === "pass" ? "fail" : classified, detail: message, raw: redact(message, secrets).slice(0, 500), latencyMs: Date.now() - started };
  }
}

export async function runCapabilities(input: { url: string; apiKey: string; model: string; messages: ChatMessage[] }): Promise<CapabilityResult[]> {
  const { url, apiKey, model } = input;
  const user = input.messages.find((message) => message.role === "user")?.content ?? "Reply with the word ok.";
  const baseMessages = [{ role: "user", content: user }];

  const streaming = await (async (): Promise<CapabilityResult> => {
    const secrets = [apiKey];
    const started = Date.now();
    try {
      const upstream = await proxyFetch({
        url,
        method: "POST",
        apiKey,
        body: JSON.stringify({ model, messages: baseMessages, stream: true, max_tokens: 16, temperature: 0 }),
        accept: "text/event-stream",
        timeoutMs: 12_000,
      });
      if (upstream.status >= 400) {
        const text = await readCappedText(upstream, secrets, LIMITS.errorBytes);
        const err = failFromUpstream(upstream.status, text, secrets);
        const classified = classify(err.message, upstream.status);
        return { name: "streaming", status: classified, detail: err.message, raw: redact(err.message, secrets).slice(0, 500), latencyMs: Date.now() - started };
      }
      try {
        requireUpstreamType(upstream, "text/event-stream");
      } catch {
        await upstream.body?.cancel().catch(() => undefined);
        return { name: "streaming", status: "fail", detail: "The response was not SSE.", raw: "", latencyMs: Date.now() - started };
      }
      const stats = await consumeSse(upstream.body, secrets, started);
      const sse = stats.text.length > 0 || stats.ttftMs !== null;
      return {
        name: "streaming",
        status: sse ? "pass" : "inconclusive",
        detail: sse ? `First token in ${stats.ttftMs ?? "?"} ms.` : "The stream did not include visible tokens.",
        raw: redact(stats.text, secrets).slice(0, 500),
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof HttpError ? err.message : "Streaming probe failed.";
      return { name: "streaming", status: classify(message, err instanceof HttpError ? err.status : 502), detail: message, raw: redact(message, secrets).slice(0, 500), latencyMs: Date.now() - started };
    }
  })();

  const tools = await probe(
    "tools",
    url,
    apiKey,
    {
      model,
      messages: [{ role: "user", content: "Call ping if you can." }],
      max_tokens: 16,
      temperature: 0,
      tools: [{ type: "function", function: { name: "ping", description: "Return pong", parameters: { type: "object", properties: {} } } }],
      tool_choice: "auto",
    },
    (_status, text) =>
      hasToolCalls(text)
        ? { status: "pass" as const, detail: "The endpoint returned tool_calls." }
        : { status: "inconclusive" as const, detail: "The endpoint accepted tools but did not return tool_calls." },
  );

  const jsonSchema = await probe(
    "json_schema",
    url,
    apiKey,
    {
      model,
      messages: [{ role: "user", content: "Return JSON with ok true." }],
      max_tokens: 32,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "probe",
          schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
          strict: true,
        },
      },
    },
    (_status, text) => {
      const ok = jsonSchemaOk(text);
      if (ok) return { status: "pass" as const, detail: "The content parsed and ok is a boolean." };
      return { status: "inconclusive" as const, detail: "The endpoint accepted json_schema but the content did not parse with a boolean ok." };
    },
  );

  const vision = await probe(
    "vision",
    url,
    apiKey,
    {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "This is a 1 by 1 pixel. What colour is it? Reply with one word: red, green, blue, black, or white." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${RED_PNG}` } },
          ],
        },
      ],
      max_tokens: 16,
      temperature: 0,
    },
    (_status, text) =>
      visionNamesRed(text)
        ? { status: "pass" as const, detail: "The endpoint named the known-colour pixel." }
        : { status: "inconclusive" as const, detail: "The endpoint accepted an image but did not name the known colour." },
  );

  return [streaming, tools, jsonSchema, vision];
}
