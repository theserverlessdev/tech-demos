import { routeAgentRequest } from "agents";
import { DESK_PATH, isStaticAssetPath, PAGE_CSP } from "./gates";
import { TOOLS } from "./tools";
import { isTestSiteKey } from "./turnstile";

export { Apollo } from "./apollo";
export { Meter } from "./meter";

/** The hub serves this demo under a path. The subdomain serves it at the root. */
const BASE_PATH = "/demos/apollo-desk";

const ALLOWED_ORIGINS = [
  "https://tech-demos.theserverless.dev",
  "https://apollo-desk.tech-demos.theserverless.dev",
  "https://tech-demos-apollo-desk.theserverlessdev.workers.dev",
];

function isAllowedOrigin(origin: string | null, url: URL): boolean {
  if (!origin) return true;
  if (origin === url.origin || ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function withPageHeaders(res: Response, html: boolean): Response {
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "DENY");
  if (html) headers.set("content-security-policy", PAGE_CSP);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;

    if (path === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }
    if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length);

    if (path.startsWith("/agents/")) {
      if (!DESK_PATH.test(path)) return new Response("Unknown desk", { status: 404 });
      if (!isAllowedOrigin(request.headers.get("origin"), url)) return new Response("Origin not allowed", { status: 403 });
      const agentUrl = new URL(request.url);
      agentUrl.pathname = path;
      const routed = await routeAgentRequest(new Request(agentUrl, request), env);
      return routed ?? new Response("Not found", { status: 404 });
    }

    if (path === "/api/health") {
      return Response.json({
        ok: true,
        model: env.AI_MODEL,
        tools: TOOLS.map((t) => ({ name: t.name, safety: t.safety })),
        turnstileSiteKey: env.TURNSTILE_SITE_KEY?.trim() ?? "",
        testSiteKey: isTestSiteKey(env.TURNSTILE_SITE_KEY),
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (!isStaticAssetPath(path)) return new Response("Not found", { status: 404, headers: { "x-content-type-options": "nosniff" } });
    const assetUrl = new URL(request.url);
    assetUrl.pathname = path === "/" ? "/index.html" : path;
    const res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
    const html = (res.headers.get("content-type") ?? "").startsWith("text/html");
    return withPageHeaders(res, html);
  },
} satisfies ExportedHandler<Env>;
