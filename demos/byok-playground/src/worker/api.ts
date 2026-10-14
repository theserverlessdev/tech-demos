import { KEY_HEADER, LIMITS } from "../shared/limits";
import type { PublicConfig, SideMetrics } from "../shared/types";
import { runWorkersAi } from "./ai";
import { claimCompare, hashIpKey, parseCap, usedToday } from "./budget";
import { runCapabilities } from "./capabilities";
import { withStream } from "./concurrency";
import type { DemoEnv } from "./env";
import { HttpError } from "./errors";
import { assertSameOrigin, clientIp, isLocalRequest, limit } from "./origin";
import { parseMaxTokens, parseMessages, parseModel, parseSystem, parseTemperature, promptFrom, readJson } from "./parse";
import { failFromUpstream, passThrough, proxyFetch, readApiKey, readBaseUrl, readCappedText, resolveTarget } from "./proxy";
import { createLogger, jsonError, redact } from "./redact";
import { requireSession } from "./session";
import { consumeSse, encodeSse } from "./stream";
import { aiStatus, isTestSiteKey, requireTurnstile } from "./turnstile";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function secretsFrom(request: Request): string[] {
  const key = (request.headers.get(KEY_HEADER) ?? "").trim();
  return key ? [key] : [];
}

export function errorResponse(err: unknown, secrets: readonly string[] = []): Response {
  if (err instanceof HttpError) return jsonError(err.status, err.code, err.message, secrets);
  createLogger(secrets).error("api_error", err);
  return jsonError(500, "internal", "The server failed. Try again.", secrets);
}

async function config(env: DemoEnv, request: Request): Promise<PublicConfig> {
  const ai = aiStatus(env, request);
  const dailyCap = parseCap(env.DAILY_COMPARE_CAP, LIMITS.dailyCompareCap);
  let used = 0;
  try {
    used = await usedToday(env);
  } catch {
    used = 0;
  }
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() || null;
  return {
    ok: true,
    model: env.AI_MODEL,
    ai,
    siteKey: ai === "off" ? null : siteKey,
    testSiteKey: isTestSiteKey(siteKey ?? undefined),
    budget: { dailyCap, used, remaining: Math.max(0, dailyCap - used) },
    limits: {
      maxTokensMax: LIMITS.maxTokensMax,
      compareMaxTokens: LIMITS.compareMaxTokens,
      requestBytes: LIMITS.requestBytes,
      timeoutMs: LIMITS.timeoutMs,
    },
  };
}

function assessOptions(request: Request) {
  return { allowLocalhost: isLocalRequest(request) };
}

function requireProxyGate(request: Request): void {
  requireSession(request);
  assertSameOrigin(request);
}

async function visitorChat(env: DemoEnv, request: Request, stream: boolean): Promise<Response> {
  requireProxyGate(request);
  await limit(env.CHAT_LIMIT, request, "chat requests");
  const apiKey = readApiKey(request);
  const body = await readJson(request);
  const target = await resolveTarget(readBaseUrl(body), "/chat/completions", assessOptions(request));
  const model = parseModel(body.model);
  const messages = parseMessages(body.messages, parseSystem(body.system));
  const temperature = parseTemperature(body.temperature);
  const maxTokens = parseMaxTokens(body.max_tokens);
  const payload = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream,
  });
  return withStream(clientIp(request), async () => {
    const upstream = await proxyFetch({
      url: target.url,
      method: "POST",
      apiKey,
      body: payload,
      accept: stream ? "text/event-stream" : "application/json",
    });
    if (upstream.status >= 400) {
      const text = await readCappedText(upstream, [apiKey], 16_384);
      throw failFromUpstream(upstream.status, text, [apiKey]);
    }
    if (stream) {
      return passThrough(upstream, [apiKey], { "content-type": "text/event-stream; charset=utf-8" });
    }
    return passThrough(upstream, [apiKey]);
  });
}

async function visitorModels(env: DemoEnv, request: Request): Promise<Response> {
  requireProxyGate(request);
  await limit(env.MODELS_LIMIT, request, "model list requests");
  const apiKey = readApiKey(request);
  const body = await readJson(request);
  const target = await resolveTarget(readBaseUrl(body), "/models", assessOptions(request));
  return withStream(clientIp(request), async () => {
    const upstream = await proxyFetch({
      url: target.url,
      method: "GET",
      apiKey,
      accept: "application/json",
    });
    if (upstream.status >= 400) {
      const text = await readCappedText(upstream, [apiKey], 16_384);
      throw failFromUpstream(upstream.status, text, [apiKey]);
    }
    return passThrough(upstream, [apiKey]);
  });
}

async function compare(env: DemoEnv, request: Request): Promise<Response> {
  requireProxyGate(request);
  await limit(env.COMPARE_LIMIT, request, "compare requests");
  const apiKey = readApiKey(request);
  const body = await readJson(request);
  await requireTurnstile(env, request, body.turnstileToken);
  const secret = env.IP_HASH_SECRET?.trim() ?? (isLocalRequest(request) ? "local-byok-ip-hash-not-for-production" : "");
  const ipKey = await hashIpKey(clientIp(request), secret);
  await claimCompare(env, ipKey);
  const target = await resolveTarget(readBaseUrl(body), "/chat/completions", assessOptions(request));
  const model = parseModel(body.model);
  const messages = parseMessages(body.messages, parseSystem(body.system));
  const temperature = parseTemperature(body.temperature);
  const maxTokens = parseMaxTokens(body.max_tokens, LIMITS.compareMaxTokens);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(encodeSse(event, data)));
      const yours = (async (): Promise<SideMetrics> => {
        const started = Date.now();
        try {
          const upstream = await proxyFetch({
            url: target.url,
            method: "POST",
            apiKey,
            body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
            accept: "text/event-stream",
          });
          if (upstream.status >= 400) {
            const text = await readCappedText(upstream, [apiKey], 8_192);
            throw failFromUpstream(upstream.status, text, [apiKey]);
          }
          const stats = await consumeSse(upstream.body, [apiKey], started);
          return {
            side: "yours",
            source: model,
            latencyMs: stats.latencyMs,
            ttftMs: stats.ttftMs,
            tokens: stats.tokens,
            text: stats.text,
            error: null,
          };
        } catch (err) {
          const message = redact(err instanceof HttpError ? err.message : "Your endpoint failed.", [apiKey]);
          return { side: "yours", source: model, latencyMs: Date.now() - started, ttftMs: null, tokens: null, text: "", error: message };
        }
      })();

      const ours = (async (): Promise<SideMetrics> => {
        const started = Date.now();
        try {
          const stats = await runWorkersAi(env, messages, maxTokens);
          return {
            side: "ours",
            source: stats.source,
            latencyMs: stats.latencyMs,
            ttftMs: stats.ttftMs,
            tokens: stats.tokens,
            text: stats.text,
            error: null,
          };
        } catch (err) {
          return {
            side: "ours",
            source: env.AI_MODEL,
            latencyMs: Date.now() - started,
            ttftMs: null,
            tokens: null,
            text: "",
            error: err instanceof Error ? err.message : "Workers AI failed.",
          };
        }
      })();

      const [yoursResult, oursResult] = await Promise.all([yours, ours]);
      send("yours", yoursResult);
      send("ours", oursResult);
      send("done", { prompt: promptFrom(messages) });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function capabilities(env: DemoEnv, request: Request): Promise<Response> {
  requireProxyGate(request);
  await limit(env.MODELS_LIMIT, request, "capability probes");
  const apiKey = readApiKey(request);
  const body = await readJson(request);
  const target = await resolveTarget(readBaseUrl(body), "/chat/completions", assessOptions(request));
  const model = parseModel(body.model);
  const messages = parseMessages(body.messages ?? [{ role: "user", content: "Reply with the word ok." }], parseSystem(body.system));
  const results = await withStream(clientIp(request), () => runCapabilities({ url: target.url, apiKey, model, messages }));
  return json({ results });
}

export async function handleApi(request: Request, env: DemoEnv, path: string): Promise<Response> {
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, model: env.AI_MODEL, ai: aiStatus(env, request) });
  }
  if (path === "/api/config" && method === "GET") return json(await config(env, request));

  if (path === "/api/proxy/chat" && method === "POST") return visitorChat(env, request, false);
  if (path === "/api/proxy/chat/stream" && method === "POST") return visitorChat(env, request, true);
  if (path === "/api/proxy/models" && method === "POST") return visitorModels(env, request);
  if (path === "/api/compare" && method === "POST") return compare(env, request);
  if (path === "/api/capabilities" && method === "POST") return capabilities(env, request);

  throw new HttpError(404, "not_found", "Unknown API route.");
}

export { secretsFrom };
