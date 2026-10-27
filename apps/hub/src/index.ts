import { demoPath, demoSubdomain, demoUrl, HUB_HOST, type DemoKind } from "@tech-demos/shared";
import { demos, getDemo } from "./registry";
import { renderGallery, THEME_BOOT_SCRIPT, GALLERY_UI_SCRIPT, ASK_PALETTE_SCRIPT } from "./gallery";
import {
  COMPATIBILITY_DATE,
  demoLoaderId,
  forwardToLoader,
  isLoaderMethodAllowed,
  sha256CspHash,
  wrapDemoResponse,
} from "./loader";

export interface Env {
  LOADER: WorkerLoader;
  ASSETS: Fetcher;
}

const TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export function slugFromHost(hostname: string): string | null {
  const suffix = `.${HUB_HOST}`;
  if (hostname.endsWith(suffix)) {
    const slug = hostname.slice(0, -suffix.length);
    if (slug && !slug.includes(".")) return slug;
  }
  return null;
}

/** Standalone fallbacks run on the hub host only. A subdomain hit is a missing deploy. */
export function standaloneBlockedOnHost(kind: DemoKind, hostname: string): boolean {
  return kind === "standalone" && slugFromHost(hostname) !== null;
}

async function galleryHeaders(): Promise<HeadersInit> {
  const [boot, ui, ask] = await Promise.all([
    sha256CspHash(THEME_BOOT_SCRIPT),
    sha256CspHash(GALLERY_UI_SCRIPT),
    sha256CspHash(ASK_PALETTE_SCRIPT),
  ]);
  const csp = [
    "default-src 'none'",
    `script-src '${boot}' '${ui}' '${ask}' https://challenges.cloudflare.com`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://ask-the-hub.tech-demos.theserverless.dev https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=60",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": csp,
  };
}

const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=60",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "x-content-type-options": "nosniff",
};

async function runDemo(request: Request, env: Env, slug: string): Promise<Response> {
  const demo = getDemo(slug);
  if (!demo) {
    return new Response("Not found", { status: 404, headers: TEXT_HEADERS });
  }

  const host = new URL(request.url).hostname;
  if (standaloneBlockedOnHost(demo.kind, host)) {
    return new Response("demo Worker not deployed", { status: 503, headers: TEXT_HEADERS });
  }

  if (!isLoaderMethodAllowed(request.method)) {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...TEXT_HEADERS, allow: "GET, HEAD" },
    });
  }

  try {
    const id = await demoLoaderId(slug, demo.source, COMPATIBILITY_DATE);
    const worker = env.LOADER.get(id, async () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: "worker.js",
      modules: {
        "worker.js": demo.source,
      },
      globalOutbound: null,
    }));

    const res = await worker.getEntrypoint().fetch(forwardToLoader(request, id));
    return wrapDemoResponse(res, id);
  } catch (err) {
    console.error(err);
    return new Response("Dynamic Worker failed", { status: 502, headers: TEXT_HEADERS });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostSlug = slugFromHost(url.hostname);

    if (hostSlug) {
      return runDemo(request, env, hostSlug);
    }

    if (url.pathname === "/api/demos") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: API_HEADERS });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: TEXT_HEADERS });
      }
      return Response.json(
        demos.map(({ slug, title, description, demonstrates, capabilities, useCases, tags, kind }) => ({
          slug,
          title,
          description,
          demonstrates,
          capabilities,
          useCases,
          tags,
          kind,
          href: demoPath(slug),
          url: demoUrl(slug),
          subdomain: demoSubdomain(slug),
        })),
        { headers: API_HEADERS },
      );
    }

    const demoMatch = url.pathname.match(/^\/demos\/([^/]+)(\/.*)?$/);
    if (demoMatch) {
      return runDemo(request, env, demoMatch[1]!);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(renderGallery(demos), {
        headers: await galleryHeaders(),
      });
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) {
      return new Response("Not found", { status: 404, headers: TEXT_HEADERS });
    }
    return asset;
  },
} satisfies ExportedHandler<Env>;
