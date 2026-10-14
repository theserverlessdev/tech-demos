import type { CapabilityResult, ChatMessage } from "../shared/types";
import { HttpError } from "./errors";
import { failFromUpstream, proxyFetch, readCappedText } from "./proxy";
import { redact } from "./redact";
import { consumeSse } from "./stream";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function classify(raw: string, status: number): CapabilityResult["status"] {
  const text = raw.toLowerCase();
  if (status === 404 || status === 405) return "unsupported";
  if (/(not support|unsupported|unknown parameter|unrecognized|invalid parameter|response_format|does not exist|no such|not enabled|not available)/i.test(text)) {
    return "unsupported";
  }
  if (status >= 200 && status < 300) return "pass";
  return "fail";
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
    const text = await readCappedText(upstream, secrets, 32_768);
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
      const contentType = upstream.headers.get("content-type") ?? "";
      if (upstream.status >= 400) {
        const text = await readCappedText(upstream, secrets, 8_192);
        const err = failFromUpstream(upstream.status, text, secrets);
        const classified = classify(err.message, upstream.status);
        return { name: "streaming", status: classified, detail: err.message, raw: redact(err.message, secrets).slice(0, 500), latencyMs: Date.now() - started };
      }
      const stats = await consumeSse(upstream.body, secrets, started);
      const sse = contentType.includes("text/event-stream") || stats.text.length > 0 || stats.ttftMs !== null;
      return {
        name: "streaming",
        status: sse ? "pass" : "fail",
        detail: sse ? `First token in ${stats.ttftMs ?? "?"} ms.` : "The response was not SSE.",
        raw: redact(stats.text || contentType, secrets).slice(0, 500),
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
    () => ({ status: "pass", detail: "The endpoint accepted tools." }),
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
    () => ({ status: "pass", detail: "The endpoint accepted json_schema." }),
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
            { type: "text", text: "What color is this pixel?" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG}` } },
          ],
        },
      ],
      max_tokens: 16,
      temperature: 0,
    },
    () => ({ status: "pass", detail: "The endpoint accepted an image part." }),
  );

  return [streaming, tools, jsonSchema, vision];
}
