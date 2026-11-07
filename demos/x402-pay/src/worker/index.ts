import { BASE_PATH, DEMO_HOST, HUB_HOST, type CanonicalArgs, type ToolName } from "../shared/protocol";
import { PayAgent } from "./agent";
import type { Env } from "./env";
import { HttpError, handleApi, type Deps } from "./http";
import type { ToolView } from "./interpret";
import { mockFacilitatorResponse, memoryStore } from "./mock-facilitator";
import { PayMCP } from "./mcp";
import { payeeForMode, resolveMode } from "./policy";
import { d1sql } from "./sql";
import { localEnabled, verifyTurnstile } from "./turnstile";

export { PayAgent, PayMCP };

const mockSettlements = memoryStore();

function pageCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src https://challenges.cloudflare.com",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function logicalPath(pathname: string): { base: string; path: string } {
  if (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`)) {
    return { base: BASE_PATH, path: pathname.slice(BASE_PATH.length) || "/" };
  }
  return { base: "", path: pathname };
}

function demoHost(hostname: string, local: boolean): boolean {
  if (hostname === DEMO_HOST || hostname === HUB_HOST) return true;
  return local;
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json(
      { paid: false, error: { code: err.code, message: err.message } },
      { status: err.status, headers: { "cache-control": "no-store" } },
    );
  }
  console.log(JSON.stringify({ event: "api_error", name: err instanceof Error ? err.name : "error" }));
  return Response.json(
    { paid: false, error: { code: "internal", message: "The server failed. Nothing is marked paid." } },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

async function agentCall(env: Env, sessionId: string, path: string, tool: ToolName, args: CanonicalArgs): Promise<ToolView> {
  const stub = env.PAY_AGENT.get(env.PAY_AGENT.idFromName(sessionId));
  const response = await stub.fetch(
    new Request(`https://pay-agent.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    }),
  );
  const body = (await response.json()) as Partial<ToolView>;
  const challenge = body.challenge && typeof body.challenge === "object" ? body.challenge : null;
  return {
    text: typeof body.text === "string" ? body.text : "",
    isError: body.isError === true,
    setup: body.setup === true,
    challenge,
    success: body.success === true,
    transaction: typeof body.transaction === "string" ? body.transaction : "",
    network: typeof body.network === "string" ? body.network : "",
    code: typeof body.code === "string" ? body.code : "",
  };
}

function buildDeps(env: Env, local: boolean): Deps {
  const mode = resolveMode({
    local,
    modeFlag: env.X402_MODE,
    facilitatorOrigin: env.MOCK_FACILITATOR_ORIGIN,
    payee: env.X402_PAYEE_ADDRESS,
    privateKey: env.X402_CLIENT_PRIVATE_KEY,
  });
  return {
    sql: d1sql(env.DB),
    now: () => Date.now(),
    local,
    mode,
    payee: payeeForMode(mode, env.X402_PAYEE_ADDRESS),
      siteKey: env.TURNSTILE_SITE_KEY ?? "",
    verify: (token, ip) => verifyTurnstile({ secret: env.TURNSTILE_SECRET ?? "", token, ip, local }),
    limit: async (bucket, key) => {
      const binding = bucket === "session" ? env.SESSION_LIMIT : bucket === "call" ? env.CALL_LIMIT : bucket === "confirm" ? env.CONFIRM_LIMIT : env.READ_LIMIT;
      const result = await binding.limit({ key: key.slice(0, 64) || "unknown" });
      return result.success;
    },
    probe: (sessionId, tool, args) => agentCall(env, sessionId, "/probe", tool, args),
    pay: (sessionId, tool, args) => agentCall(env, sessionId, "/pay", tool, args),
  };
}

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const assetUrl = new URL(request.url);
  assetUrl.pathname = path === "/" ? "/index.html" : path;
  let response = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  if (response.status === 404 && !path.startsWith("/assets/")) {
    assetUrl.pathname = "/index.html";
    response = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  }
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  if ((headers.get("content-type") ?? "").startsWith("text/html")) {
    headers.set("content-security-policy", pageCsp());
    headers.set("cache-control", "no-cache");
  }
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const local = localEnabled(env.LOCAL_DEV, url.hostname, request.headers.get("cf-ray"));
    const mode = resolveMode({
      local,
      modeFlag: env.X402_MODE,
      facilitatorOrigin: env.MOCK_FACILITATOR_ORIGIN,
      payee: env.X402_PAYEE_ADDRESS,
      privateKey: env.X402_CLIENT_PRIVATE_KEY,
    });
    if (url.pathname.includes("/internal/mock-facilitator/")) {
      if (mode !== "mock" || !local) return new Response("Not found", { status: 404 });
      const mocked = await mockFacilitatorResponse(request, mockSettlements);
      return mocked ?? new Response("Not found", { status: 404 });
    }
    const { base, path } = logicalPath(url.pathname);
    if (url.pathname === BASE_PATH) return Response.redirect(`${url.origin}${BASE_PATH}/${url.search}`, 308);
    if (!demoHost(url.hostname, local)) return new Response("This demo is unavailable.", { status: 503 });
    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, buildDeps(env, local), path, base);
      } catch (err) {
        return errorResponse(err);
      }
    }
    return serveAsset(request, env, path);
  },
} satisfies ExportedHandler<Env>;
