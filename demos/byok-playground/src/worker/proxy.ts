import { LIMITS, type AllowedSuffix } from "../shared/limits";
import { readCappedBytes, rejectOversizedContentLength } from "./bytes";
import { HttpError } from "./errors";
import { apiHeaders, mimeType, outboundHeaders } from "./headers";
import { isRecord } from "./parse";
import { createExactRedactor, redact, redactExact } from "./redact";
import { authorizeNavigation, cloudflareDoh, decisionToError, joinAllowedPath, type AssessOptions, type Lookup } from "./ssrf";
import { encodeSse } from "./stream";

export function readApiKey(body: Record<string, unknown>): string {
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!key) throw new HttpError(400, "key", "Paste an API key. It is sent in the JSON body, not stored.");
  if (key.length > LIMITS.maxKeyChars) throw new HttpError(400, "key", "That API key is too long.");
  if (/[\r\n]/.test(key)) throw new HttpError(400, "key", "That API key is not allowed.");
  return key;
}

export function readBaseUrl(body: Record<string, unknown>): string {
  if (typeof body.baseUrl !== "string") throw new HttpError(400, "url", "Enter an https base URL.");
  return body.baseUrl.trim();
}

export async function resolveTarget(
  baseUrl: string,
  suffix: AllowedSuffix,
  options: AssessOptions,
  lookup: Lookup = cloudflareDoh,
): Promise<{ url: string; secrets: string[] }> {
  const assessed = await authorizeNavigation(baseUrl, lookup, options);
  if (!assessed.ok) throw decisionToError(assessed);
  return { url: joinAllowedPath(assessed.url, suffix), secrets: [] };
}

export type ProxyInit = {
  url: string;
  method: "GET" | "POST";
  apiKey: string;
  body?: string;
  accept: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function proxyFetch(init: ProxyInit): Promise<Response> {
  const secrets = [init.apiKey];
  if (init.body && new TextEncoder().encode(init.body).length > LIMITS.requestBytes) {
    throw new HttpError(413, "too_large", "The request body is too large.");
  }
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  init.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? LIMITS.timeoutMs);
  let upstream: Response;
  try {
    upstream = await fetch(init.url, {
      method: init.method,
      headers: outboundHeaders(init.apiKey, init.accept),
      body: init.method === "POST" ? init.body : undefined,
      redirect: "manual",
      signal: ac.signal,
    });
  } catch (err) {
    throw new HttpError(502, "upstream", redact(err instanceof Error ? err.message : "The endpoint could not be reached.", secrets));
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new HttpError(502, "redirect", redact("The endpoint returned a redirect. Redirects are not followed.", secrets));
  }
  return upstream;
}

type CapOptions = {
  maxBytes?: number;
  sse?: boolean;
  exact?: boolean;
  signal?: AbortSignal;
};

function failFrame(controller: ReadableStreamDefaultController<Uint8Array>, sse: boolean, message: string): void {
  if (sse) controller.enqueue(new TextEncoder().encode(encodeSse("error", { message })));
  controller.close();
}

export function cappedBody(upstream: Response, secrets: readonly string[], options: CapOptions = {}): ReadableStream<Uint8Array> {
  const maxBytes = options.maxBytes ?? LIMITS.responseBytes;
  const reader = upstream.body?.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const redactor = options.exact ? createExactRedactor(secrets) : null;
  const started = Date.now();
  let seen = 0;
  let stopped = false;

  const stop = async (controller: ReadableStreamDefaultController<Uint8Array>, message?: string) => {
    if (stopped) return;
    stopped = true;
    if (message) failFrame(controller, Boolean(options.sse), message);
    else controller.close();
    await reader?.cancel().catch(() => undefined);
  };

  if (!reader) {
    return new ReadableStream({
      start(controller) {
        if (redactor) {
          const tail = redactor.flush();
          if (tail) controller.enqueue(encoder.encode(tail));
        }
        controller.close();
      },
    });
  }

  return new ReadableStream({
    async pull(controller) {
      if (stopped) return;
      const remaining = LIMITS.overallTimeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        await stop(controller, "The endpoint took too long.");
        return;
      }
      if (options.signal?.aborted) {
        await stop(controller, "The stream was cancelled.");
        return;
      }
      const wait = Math.min(LIMITS.idleTimeoutMs, remaining);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("idle")), wait);
            options.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("cancelled"));
            });
          }),
        ]);
      } catch (err) {
        const message = err instanceof Error && err.message === "cancelled" ? "The stream was cancelled." : "The endpoint timed out waiting for the next chunk.";
        await stop(controller, message);
        return;
      }
      if (chunk.done) {
        const tail = decoder.decode();
        const flushed = redactor ? redactor.push(tail, true) : redact(tail, secrets);
        if (flushed) controller.enqueue(encoder.encode(flushed));
        await stop(controller);
        return;
      }
      seen += chunk.value.byteLength;
      if (seen > maxBytes) {
        await stop(controller, "The endpoint response was too large.");
        return;
      }
      const text = decoder.decode(chunk.value, { stream: true });
      const out = redactor ? redactor.push(text) : redact(text, secrets);
      if (out) controller.enqueue(encoder.encode(out));
    },
    cancel() {
      stopped = true;
      return reader.cancel();
    },
  });
}

export async function readCappedText(upstream: Response, secrets: readonly string[], maxBytes: number = LIMITS.responseBytes): Promise<string> {
  rejectOversizedContentLength(upstream.headers, maxBytes, "The endpoint response was too large.");
  const bytes = await readCappedBytes(
    upstream.body,
    maxBytes,
    new HttpError(502, "too_large", "The endpoint response was too large."),
  );
  return redact(new TextDecoder().decode(bytes), secrets);
}

export function jsonBody(data: unknown, secrets: readonly string[], status = 200): Response {
  const body = redactExact(JSON.stringify(data), secrets);
  return new Response(body, { status, headers: apiHeaders("json") });
}

export function validateModelsPayload(text: string): { data: { id: string }[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(502, "upstream", "The endpoint did not return JSON.");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw new HttpError(502, "upstream", "The endpoint /models response must be { data: [{ id }] }.");
  }
  const data = parsed.data
    .filter((row): row is Record<string, unknown> => isRecord(row) && typeof row.id === "string" && Boolean(row.id.trim()))
    .slice(0, 200)
    .map((row) => ({ id: String(row.id).slice(0, LIMITS.maxModelChars) }));
  return { data };
}

export function validateChatJson(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(502, "upstream", "The endpoint did not return JSON.");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw new HttpError(502, "upstream", "The endpoint chat response must be JSON with a choices array.");
  }
  return parsed;
}

export function requireUpstreamType(upstream: Response, expected: "application/json" | "text/event-stream"): void {
  const mime = mimeType(upstream.headers);
  if (mime !== expected) {
    throw new HttpError(502, "upstream", expected === "text/event-stream" ? "The endpoint stream must be text/event-stream." : "The endpoint must return application/json.");
  }
}

export function ssePassThrough(upstream: Response, secrets: readonly string[]): Response {
  return new Response(cappedBody(upstream, secrets, { sse: true, exact: true }), {
    status: upstream.status,
    headers: apiHeaders("sse"),
  });
}

export function failFromUpstream(status: number, body: string, secrets: readonly string[]): HttpError {
  const redacted = redact(body, secrets).slice(0, 800);
  let message = "The endpoint returned an error.";
  try {
    const parsed = JSON.parse(redacted) as { error?: { message?: string } | string };
    if (typeof parsed.error === "string") message = parsed.error;
    else if (parsed.error?.message) message = parsed.error.message;
  } catch {
    if (redacted) message = redacted.slice(0, 240);
  }
  return new HttpError(status >= 400 && status < 600 ? status : 502, "upstream", redact(message, secrets));
}
