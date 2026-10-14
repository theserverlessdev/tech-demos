import { KEY_HEADER, LIMITS, type AllowedSuffix } from "../shared/limits";
import { HttpError } from "./errors";
import { outboundHeaders, sanitizeResponseHeaders } from "./headers";
import { redact } from "./redact";
import { authorizeNavigation, cloudflareDoh, decisionToError, joinAllowedPath, type AssessOptions, type Lookup } from "./ssrf";

export function readApiKey(request: Request): string {
  const key = (request.headers.get(KEY_HEADER) ?? "").trim();
  if (!key) throw new HttpError(400, "key", "Paste an API key. It is sent in a header, not stored.");
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

function rejectRedirect(status: number, secrets: readonly string[]): void {
  if (status >= 300 && status < 400) {
    throw new HttpError(502, "redirect", redact("The endpoint returned a redirect. Redirects are not followed.", secrets));
  }
}

export type ProxyInit = {
  url: string;
  method: "GET" | "POST";
  apiKey: string;
  body?: string;
  accept: string;
  timeoutMs?: number;
};

export async function proxyFetch(init: ProxyInit): Promise<Response> {
  const secrets = [init.apiKey];
  if (init.body && init.body.length > LIMITS.requestBytes) {
    throw new HttpError(413, "too_large", "The request body is too large.");
  }
  let upstream: Response;
  try {
    upstream = await fetch(init.url, {
      method: init.method,
      headers: outboundHeaders(init.apiKey, init.accept),
      body: init.method === "POST" ? init.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs ?? LIMITS.timeoutMs),
    });
  } catch (err) {
    throw new HttpError(502, "upstream", redact(err instanceof Error ? err.message : "The endpoint could not be reached.", secrets));
  }
  rejectRedirect(upstream.status, secrets);
  return upstream;
}

export function cappedBody(upstream: Response, secrets: readonly string[], maxBytes: number = LIMITS.responseBytes): ReadableStream<Uint8Array> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }
  let seen = 0;
  const decoder = new TextDecoder();
  let carry = "";
  return new ReadableStream({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      seen += chunk.value.byteLength;
      if (seen > maxBytes) {
        controller.error(new HttpError(502, "too_large", "The endpoint response was too large."));
        await reader.cancel().catch(() => undefined);
        return;
      }
      const text = carry + decoder.decode(chunk.value, { stream: true });
      const redacted = redact(text, secrets);
      carry = "";
      controller.enqueue(new TextEncoder().encode(redacted));
    },
    cancel() {
      return reader.cancel();
    },
  });
}

export async function readCappedText(upstream: Response, secrets: readonly string[], maxBytes: number = LIMITS.responseBytes): Promise<string> {
  const raw = await upstream.text();
  if (raw.length > maxBytes) throw new HttpError(502, "too_large", "The endpoint response was too large.");
  return redact(raw, secrets);
}

export function passThrough(upstream: Response, secrets: readonly string[], extra: HeadersInit = {}): Response {
  const headers = sanitizeResponseHeaders(upstream.headers);
  for (const [name, value] of new Headers(extra)) headers.set(name, value);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  const body = upstream.body ? cappedBody(upstream, secrets) : null;
  return new Response(body, { status: upstream.status, headers });
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
