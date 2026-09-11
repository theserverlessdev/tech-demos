import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import type { Viewer } from "../shared/types";
import { BLUEPRINT_INFOS } from "./blueprints";
import type { Workspace } from "./workspace";

export { Workspace } from "./workspace";
export { Meter } from "./meter";
export { WebGatekeeper, AiGatekeeper } from "./gatekeepers";

/** The hub serves this demo under a path. The subdomain serves it at the root. */
const BASE_PATH = "/demos/cloudflare-os";

const WORKSPACE_ID = /^[a-z0-9]{8,24}$/;

const ALLOWED_ORIGINS = [
  "https://tech-demos.theserverless.dev",
  "https://cloudflare-os.tech-demos.theserverless.dev",
  "https://tech-demos-cloudflare-os.theserverlessdev.workers.dev",
];

function cleanViewer(v: Viewer): Viewer {
  const text = (s: unknown, max: number) => String(s ?? "").slice(0, max);
  const color = /^#[0-9a-f]{6}$/i.test(String(v?.color)) ? v.color : "#c2410c";
  return { id: text(v?.id, 40), name: text(v?.name, 40) || "Visitor", color };
}

/**
 * The Cap'n Web root object. The browser holds one per WebSocket. Upstream calls this
 * `PublicApiImpl`. It hands out workspace sessions, which live in the Workspace Durable Object.
 */
class PublicApi extends RpcTarget {
  constructor(
    private env: Env,
    private ip: string,
  ) {
    super();
  }

  openWorkspace(id: string, viewer: Viewer) {
    if (!WORKSPACE_ID.test(id)) throw new Error("Invalid workspace id.");
    const ns = this.env.WORKSPACES as unknown as DurableObjectNamespace<Workspace>;
    return ns.getByName(id).openSession(id, cleanViewer(viewer), this.ip);
  }

  listBlueprints() {
    return BLUEPRINT_INFOS;
  }
}

function isAllowedOrigin(origin: string | null, url: URL): boolean {
  if (!origin) return true;
  if (origin === url.origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;
    let base = "";

    if (path === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }
    if (path.startsWith(`${BASE_PATH}/`)) {
      base = BASE_PATH;
      path = path.slice(BASE_PATH.length);
    }

    if (path === "/api") {
      if (!isAllowedOrigin(request.headers.get("origin"), url)) {
        return new Response("Origin not allowed", { status: 403 });
      }
      const ip = request.headers.get("cf-connecting-ip") ?? "local";
      return newWorkersRpcResponse(request, new PublicApi(env, ip));
    }

    if (path === "/api/health") {
      return Response.json({ ok: true, base, blueprints: BLUEPRINT_INFOS.map((b) => b.id) });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const assetUrl = new URL(request.url);
    assetUrl.pathname = path === "/" ? "/index.html" : path;
    const res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
    if (res.status === 404 && !path.startsWith("/assets/")) {
      assetUrl.pathname = "/index.html";
      return env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
    }
    return res;
  },
} satisfies ExportedHandler<Env>;
