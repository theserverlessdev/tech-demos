import { LIMITS } from "../shared/limits";
import type { PublicConfig, SideMetrics } from "../shared/types";
import { runWorkersAi } from "./ai";
import { claimCompare, hashIpKey, parseCap, usedToday } from "./budget";
import { runCapabilities } from "./capabilities";
import { isLocalEnv, publicSiteKey } from "./env";
import { HttpError } from "./errors";
import { apiHeaders } from "./headers";
import { assertSameOrigin, clientIp, isLocalRequest, limit } from "./origin";
import { parseMaxTokens, parseMessages, parseModel, parseSystem, parseTemperature, promptFrom, readJson } from "./parse";
import {
  failFromUpstream,
  jsonBody,
  proxyFetch,
  readApiKey,
  readBaseUrl,
  readCappedText,
  requireUpstreamType,
  resolveTarget,
  ssePassThrough,
  validateChatJson,
  validateModelsPayload,
} from "./proxy";
import { createLogger, jsonError, redact } from "./redact";
import { finish, mintSignedSession, requireSession } from "./session";
import { consumeSse, encodeSse } from "./stream";
import { aiStatus, isTestSiteKey, requireTurnstile, sessionGate } from "./turnstile";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: apiHeaders("json") });
}

export function errorResponse(err: unknown, secrets: readonly string[] = []): Response {
  if (err instanceof HttpError) return jsonError(err.status, err.code, err.message, secrets);
  createLogger(secrets).error("api_error", err);
  return jsonError(500, "internal", "The server failed. Try again.", secrets);
}

async function config(env: Env): Promise<PublicConfig> {
  const ai = aiStatus(env);
  const dailyCap = parseCap(env.DAILY_COMPARE_CAP, LIMITS.dailyCompareCap);
  let used = 0;
  try {
    used = await usedToday(env);
  } catch {
    used = 0;
  }
  const siteKey = publicSiteKey(env);
  return {
    ok: true,
    model: env.AI_MODEL,
    ai,
    session: sessionGate(env),
    siteKey,
    testSiteKey: isTestSiteKey(siteKey),
    budget: { dailyCap, used, remaining: Math.max(0, dailyCap - used) },
    limits: {
      maxTokensMax: LIMITS.maxTokensMax,
      compareMaxTokens: LIMITS.compareMaxTokens,
      requestBytes: LIMITS.requestBytes,
      timeoutMs: LIMITS.timeoutMs,
      maxMessages: LIMITS.maxMessages,
      maxMessageBytes: LIMITS.maxMessageBytes,
      maxSystemBytes: LIMITS.maxSystemBytes,
    },
  };
}

function assessOptions(env: Env, request: Request) {
  return { allowLocalhost: isLocalEnv(env) && isLocalRequest(request) };
}

async function requireProxyGate(request: Request, env: Env): Promise<void> {
  await requireSession(request, env);
  assertSameOrigin(request);
}

async function visitorChat(env: Env, request: Request, stream: boolean): Promise<Response> {
  await requireProxyGate(request, env);
  await limit(env.CHAT_LIMIT, request, "chat requests");
  const body = await readJson(request);
  const apiKey = readApiKey(body);
  const target = await resolveTarget(readBaseUrl(body), "/chat/completions", assessOptions(env, request));
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
  if (!stream) {
    const upstream = await proxyFetch({
      url: target.url,
      method: "POST",
      apiKey,
      body: payload,
      accept: "application/json",
    });
    if (upstream.status >= 400) {
      const text = await readCappedText(upstream, [apiKey], LIMITS.errorBytes);
      throw failFromUpstream(upstream.status, text, [apiKey]);
    }
    try {
      requireUpstreamType(upstream, "application/json");
    } catch (err) {
      await upstream.body?.cancel().catch(() => undefined);
      throw err;
    }
    const text = await readCappedText(upstream, [apiKey], LIMITS.responseBytes, { exact: true });
    return jsonBody(validateChatJson(text), [apiKey], upstream.status);
  }

  const upstream = await proxyFetch({
    url: target.url,
    method: "POST",
    apiKey,
    body: payload,
    accept: "text/event-stream",
  });
  if (upstream.status >= 400) {
    const text = await readCappedText(upstream, [apiKey], LIMITS.errorBytes);
    throw failFromUpstream(upstream.status, text, [apiKey]);
  }
  try {
    requireUpstreamType(upstream, "text/event-stream");
  } catch (err) {
    await upstream.body?.cancel().catch(() => undefined);
    throw err;
  }
  return ssePassThrough(upstream, [apiKey], request.signal);
}

async function visitorModels(env: Env, request: Request): Promise<Response> {
  await requireProxyGate(request, env);
  await limit(env.MODELS_LIMIT, request, "model list requests");
  const body = await readJson(request);
  const apiKey = readApiKey(body);
  const target = await resolveTarget(readBaseUrl(body), "/models", assessOptions(env, request));
  const upstream = await proxyFetch({
    url: target.url,
    method: "GET",
    apiKey,
    accept: "application/json",
  });
  if (upstream.status >= 400) {
    const text = await readCappedText(upstream, [apiKey], LIMITS.errorBytes);
    throw failFromUpstream(upstream.status, text, [apiKey]);
  }
  try {
    requireUpstreamType(upstream, "application/json");
  } catch (err) {
    await upstream.body?.cancel().catch(() => undefined);
    throw err;
  }
  const text = await readCappedText(upstream, [apiKey], LIMITS.responseBytes, { exact: true });
  return jsonBody(validateModelsPayload(text), [apiKey]);
}

async function compare(env: Env, request: Request): Promise<Response> {
  await requireProxyGate(request, env);
  if (aiStatus(env) === "off") {
    throw new HttpError(503, "compare_off", "Compare is off until Turnstile and Workers AI are configured.");
  }
  await limit(env.COMPARE_LIMIT, request, "compare requests");
  const body = await readJson(request);
  const apiKey = readApiKey(body);
  const target = await resolveTarget(readBaseUrl(body), "/chat/completions", assessOptions(env, request));
  const model = parseModel(body.model);
  const messages = parseMessages(body.messages, parseSystem(body.system));
  const temperature = parseTemperature(body.temperature);
  const maxTokens = parseMaxTokens(body.max_tokens, LIMITS.compareMaxTokens);
  await requireTurnstile(env, request, body.turnstileToken, "compare");
  const secret = env.IP_HASH_SECRET?.trim() ?? (isLocalEnv(env) ? "local-byok-ip-hash-not-for-production" : "");
  const ipKey = await hashIpKey(clientIp(request), secret);
  await claimCompare(env, ipKey);
  const encoder = new TextEncoder();
  const ac = new AbortController();
  const stop = () => ac.abort();
  request.signal.addEventListener("abort", stop);
  const overall = setTimeout(() => ac.abort(), LIMITS.overallTimeoutMs);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(encodeSse(event, data)));
        } catch {
          /* closed */
        }
      };
      const yours = (async (): Promise<SideMetrics> => {
        const started = Date.now();
        try {
          const upstream = await proxyFetch({
            url: target.url,
            method: "POST",
            apiKey,
            body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
            accept: "text/event-stream",
            signal: ac.signal,
          });
          if (upstream.status >= 400) {
            const text = await readCappedText(upstream, [apiKey], LIMITS.errorBytes, { signal: ac.signal });
            throw failFromUpstream(upstream.status, text, [apiKey]);
          }
          try {
            requireUpstreamType(upstream, "text/event-stream");
          } catch (err) {
            await upstream.body?.cancel().catch(() => undefined);
            throw err;
          }
          const stats = await consumeSse(upstream.body, [apiKey], started, { signal: ac.signal });
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
          const stats = await runWorkersAi(env, messages, maxTokens, ac.signal);
          return {
            side: "ours",
            source: stats.source,
            latencyMs: stats.latencyMs,
            ttftMs: stats.ttftMs,
            tokens: stats.tokens,
            text: stats.text,
            error: null,
          };
        } catch {
          return {
            side: "ours",
            source: env.AI_MODEL,
            latencyMs: Date.now() - started,
            ttftMs: null,
            tokens: null,
            text: "",
            error: "Workers AI failed.",
          };
        }
      })();

      try {
        const sendSide = async (pending: Promise<SideMetrics>) => {
          const result = await pending;
          send(result.side, result);
        };
        await Promise.all([sendSide(yours), sendSide(ours)]);
        send("done", { prompt: promptFrom(messages) });
        controller.close();
      } catch {
        send("error", { message: "Compare failed." });
        controller.close();
      } finally {
        clearTimeout(overall);
        request.signal.removeEventListener("abort", stop);
      }
    },
    cancel() {
      clearTimeout(overall);
      ac.abort();
      request.signal.removeEventListener("abort", stop);
    },
  });

  return new Response(stream, { headers: apiHeaders("sse") });
}

async function capabilities(env: Env, request: Request): Promise<Response> {
  await requireProxyGate(request, env);
  await limit(env.MODELS_LIMIT, request, "capability probes");
  const body = await readJson(request);
  const apiKey = readApiKey(body);
  const target = await resolveTarget(readBaseUrl(body), "/chat/completions", assessOptions(env, request));
  const model = parseModel(body.model);
  const messages = parseMessages(body.messages ?? [{ role: "user", content: "Reply with the word ok." }], parseSystem(body.system));
  const results = await runCapabilities({ url: target.url, apiKey, model, messages });
  return json({ results });
}

async function mintSession(env: Env, request: Request): Promise<Response> {
  assertSameOrigin(request);
  await limit(env.SESSION_LIMIT, request, "session mints");
  const body = await readJson(request);
  const siteKey = publicSiteKey(env);
  const localMint = isLocalEnv(env) && isLocalRequest(request);
  if (siteKey) await requireTurnstile(env, request, body.turnstileToken, "session");
  else if (!localMint) {
    throw new HttpError(503, "turnstile_unconfigured", "Proxy is off until Turnstile is configured.");
  }
  const minted = await mintSignedSession(env, request);
  return finish(json({ ok: true }), minted.cookie);
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: apiHeaders("json") });

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, model: env.AI_MODEL, ai: aiStatus(env) });
  }
  if (path === "/api/config" && method === "GET") return json(await config(env));
  if (path === "/api/session" && method === "POST") return mintSession(env, request);

  if (path === "/api/proxy/chat" && method === "POST") return visitorChat(env, request, false);
  if (path === "/api/proxy/chat/stream" && method === "POST") return visitorChat(env, request, true);
  if (path === "/api/proxy/models" && method === "POST") return visitorModels(env, request);
  if (path === "/api/compare" && method === "POST") return compare(env, request);
  if (path === "/api/capabilities" && method === "POST") return capabilities(env, request);

  throw new HttpError(404, "not_found", "Unknown API route.");
}
