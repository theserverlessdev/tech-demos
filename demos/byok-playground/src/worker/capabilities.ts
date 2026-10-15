import type { CapabilityResult, ChatMessage } from "../shared/types";
import { LIMITS } from "../shared/limits";
import { pickVisionTarget, type VisionColour } from "../shared/png";
import { HttpError } from "./errors";
import { isRecord } from "./parse";
import { failFromUpstream, proxyFetch, readCappedText, requireUpstreamType } from "./proxy";
import { redact } from "./redact";
import { consumeSse } from "./stream";

const COLOUR_WORD = /\b(red|green|blue|black|white)\b/gi;

export function isModelNotFound(status: number, raw: string): boolean {
  if (status < 400) return false;
  return /model[_ ]?not[_ ]?found|invalid model|model .+ does not exist|does not exist.*model|no such model|unknown model/i.test(raw);
}

export function isPathNotFound(status: number, raw: string): boolean {
  return status === 404 && !isModelNotFound(status, raw);
}

function classify(raw: string, status: number): CapabilityResult["status"] {
  if (isModelNotFound(status, raw)) return "fail";
  if (status === 405) return "unsupported";
  if (/(not support|unsupported|unknown parameter|unrecognized|invalid parameter|response_format|not enabled|not available)/i.test(raw)) {
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

export function jsonSchemaOk(text: string, nonce: string): boolean | null {
  const content = messageContent(text);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) return null;
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !keys.includes("ok") || !keys.includes("nonce")) return null;
    if (typeof parsed.ok !== "boolean") return null;
    if (parsed.nonce !== nonce) return null;
    return true;
  } catch {
    return null;
  }
}

/** Pass only if message.content names exactly one of the colour words, and it is `colour`. */
export function visionNamesColour(text: string, colour: VisionColour): boolean {
  const content = messageContent(text);
  if (!content) return false;
  const words = [...content.toLowerCase().matchAll(COLOUR_WORD)].map((match) => match[1]);
  const unique = new Set(words);
  return unique.size === 1 && unique.has(colour);
}

function missingModelResult(name: CapabilityResult["name"], raw: string, latencyMs: number): CapabilityResult {
  return { name, status: "fail", detail: "model not found", raw: raw.slice(0, 500), latencyMs };
}

function pathNotFoundResult(name: CapabilityResult["name"], raw: string, latencyMs: number): CapabilityResult {
  return { name, status: "fail", detail: "endpoint path not found — check the base URL", raw: raw.slice(0, 500), latencyMs };
}

async function probe(
  name: CapabilityResult["name"],
  url: string,
  apiKey: string,
  body: unknown,
  check: (status: number, text: string) => { status: CapabilityResult["status"]; detail: string },
  deadline: number,
): Promise<CapabilityResult> {
  const secrets = [apiKey];
  const started = Date.now();
  const remaining = Math.max(1, deadline - Date.now());
  try {
    const upstream = await proxyFetch({
      url,
      method: "POST",
      apiKey,
      body: JSON.stringify(body),
      accept: "application/json",
      timeoutMs: Math.min(LIMITS.capabilityProbeMs, remaining),
    });
    const text = await readCappedText(upstream, secrets, LIMITS.probeBytes, {
      exact: upstream.status < 400,
      idleMs: Math.min(LIMITS.idleTimeoutMs, remaining),
      overallMs: Math.min(LIMITS.capabilityProbeMs, remaining),
    });
    if (isModelNotFound(upstream.status, text)) {
      return missingModelResult(name, redact(text, secrets), Date.now() - started);
    }
    if (isPathNotFound(upstream.status, text)) {
      return pathNotFoundResult(name, redact(text, secrets), Date.now() - started);
    }
    if (upstream.status >= 400) {
      const err = failFromUpstream(upstream.status, text, secrets);
      if (isModelNotFound(upstream.status, err.message)) {
        return missingModelResult(name, redact(err.message, secrets), Date.now() - started);
      }
      const classified = classify(err.message, upstream.status);
      return { name, status: classified, detail: classified === "unsupported" ? "The endpoint rejected this parameter." : "The endpoint returned an error.", raw: redact(err.message, secrets).slice(0, 500), latencyMs: Date.now() - started };
    }
    const result = check(upstream.status, text);
    return { name, status: result.status, detail: result.detail, raw: redact(text, secrets).slice(0, 500), latencyMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof HttpError ? err.message : "The probe failed.";
    const status = err instanceof HttpError ? err.status : 502;
    if (isModelNotFound(status, message)) return missingModelResult(name, redact(message, secrets), Date.now() - started);
    const classified = classify(message, status);
    return { name, status: classified, detail: message, raw: redact(message, secrets).slice(0, 500), latencyMs: Date.now() - started };
  }
}

export async function runCapabilities(input: { url: string; apiKey: string; model: string; messages: ChatMessage[] }): Promise<CapabilityResult[]> {
  const { url, apiKey, model } = input;
  const user = input.messages.find((message) => message.role === "user")?.content ?? "Reply with the word ok.";
  const baseMessages = [{ role: "user", content: user }];
  const deadline = Date.now() + LIMITS.capabilityTotalMs;
  const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const visionTarget = pickVisionTarget();

  const streaming = await (async (): Promise<CapabilityResult> => {
    const secrets = [apiKey];
    const started = Date.now();
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const upstream = await proxyFetch({
        url,
        method: "POST",
        apiKey,
        body: JSON.stringify({ model, messages: baseMessages, stream: true, max_tokens: 16, temperature: 0 }),
        accept: "text/event-stream",
        timeoutMs: Math.min(LIMITS.capabilityProbeMs, remaining),
      });
      if (upstream.status >= 400) {
        const text = await readCappedText(upstream, secrets, LIMITS.errorBytes, {
          idleMs: Math.min(LIMITS.idleTimeoutMs, remaining),
          overallMs: Math.min(LIMITS.capabilityProbeMs, remaining),
        });
        const err = failFromUpstream(upstream.status, text, secrets);
        if (isModelNotFound(upstream.status, `${err.message} ${text}`)) {
          return missingModelResult("streaming", redact(err.message, secrets), Date.now() - started);
        }
        if (isPathNotFound(upstream.status, `${err.message} ${text}`)) {
          return pathNotFoundResult("streaming", redact(err.message, secrets), Date.now() - started);
        }
        const classified = classify(err.message, upstream.status);
        return { name: "streaming", status: classified, detail: err.message, raw: redact(err.message, secrets).slice(0, 500), latencyMs: Date.now() - started };
      }
      try {
        requireUpstreamType(upstream, "text/event-stream");
      } catch {
        await upstream.body?.cancel().catch(() => undefined);
        return { name: "streaming", status: "fail", detail: "The response was not SSE.", raw: "", latencyMs: Date.now() - started };
      }
      const stats = await consumeSse(upstream.body, secrets, started, {
        signal: AbortSignal.timeout(Math.min(LIMITS.capabilityProbeMs, remaining)),
        idleMs: Math.min(15_000, remaining),
        overallMs: Math.min(LIMITS.capabilityProbeMs, remaining),
      });
      const sse = stats.text.length > 0 || stats.ttftMs !== null;
      return {
        name: "streaming",
        status: sse ? "pass" : "inconclusive",
        detail: sse ? `First token in ${stats.ttftMs ?? "?"} ms.` : "The stream did not include visible tokens.",
        raw: stats.text.slice(0, 500),
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof HttpError ? err.message : "Streaming probe failed.";
      const status = err instanceof HttpError ? err.status : 502;
      if (isModelNotFound(status, message)) {
        return missingModelResult("streaming", redact(message, secrets), Date.now() - started);
      }
      return { name: "streaming", status: classify(message, status), detail: message, raw: redact(message, secrets).slice(0, 500), latencyMs: Date.now() - started };
    }
  })();

  if (streaming.detail === "model not found") return [streaming];

  const timedOut = (name: CapabilityResult["name"]): CapabilityResult => ({
    name,
    status: "fail",
    detail: "Capability checks timed out.",
    raw: "",
    latencyMs: 0,
  });

  const tools = Date.now() >= deadline
    ? timedOut("tools")
    : await probe(
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
        deadline,
      );
  if (tools.detail === "model not found") return [tools];

  const jsonSchema = Date.now() >= deadline
    ? timedOut("json_schema")
    : await probe(
        "json_schema",
        url,
        apiKey,
        {
          model,
          messages: [{ role: "user", content: "Return JSON" }],
          max_tokens: 32,
          temperature: 0,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "probe",
              schema: {
                type: "object",
                properties: { ok: { type: "boolean" }, nonce: { type: "string", const: nonce } },
                required: ["ok", "nonce"],
                additionalProperties: false,
              },
              strict: true,
            },
          },
        },
        (_status, text) => {
          const ok = jsonSchemaOk(text, nonce);
          if (ok) return { status: "pass" as const, detail: "The content parsed with the required keys and nonce." };
          return { status: "inconclusive" as const, detail: "The endpoint accepted json_schema but did not return the required keys and nonce." };
        },
        deadline,
      );
  if (jsonSchema.detail === "model not found") return [jsonSchema];

  const vision = Date.now() >= deadline
    ? timedOut("vision")
    : await probe(
        "vision",
        url,
        apiKey,
        {
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "This image is two pixels side by side. What colour is the LEFT pixel? Reply with one word." },
                { type: "image_url", image_url: { url: `data:image/png;base64,${visionTarget.png}` } },
              ],
            },
          ],
          max_tokens: 16,
          temperature: 0,
        },
        (_status, text) =>
          visionNamesColour(text, visionTarget.left)
            ? { status: "pass" as const, detail: "The endpoint named the left pixel colour." }
            : { status: "inconclusive" as const, detail: "The endpoint accepted an image but did not name the left pixel colour." },
        deadline,
      );

  return [streaming, tools, jsonSchema, vision];
}
