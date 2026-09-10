import { demoPath, demoSubdomain, demoUrl, HUB_HOST } from "@tech-demos/shared";
import { demos, getDemo } from "./registry";

export interface Env {
  LOADER: WorkerLoader;
  ASSETS: Fetcher;
}

function slugFromHost(hostname: string): string | null {
  const suffix = `.${HUB_HOST}`;
  if (hostname.endsWith(suffix)) {
    const slug = hostname.slice(0, -suffix.length);
    if (slug && !slug.includes(".")) return slug;
  }
  return null;
}

async function runDemo(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const demo = getDemo(slug);
  if (!demo) {
    return new Response(`Unknown demo: ${slug}`, { status: 404 });
  }

  try {
    // Stable ID so repeat hits to the same demo code count as one Dynamic Worker / day.
    const worker = env.LOADER.get(slug, async () => ({
      compatibilityDate: "2026-09-01",
      mainModule: "worker.js",
      modules: {
        "worker.js": demo.source,
      },
      // Demos start locked down; open egress per-demo later if needed.
      globalOutbound: null,
    }));

    return await worker.getEntrypoint().fetch(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Dynamic Worker failed for ${slug}: ${message}`, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
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
      return Response.json(
        demos.map(({ slug, title, description, tags }) => ({
          slug,
          title,
          description,
          tags,
          href: demoPath(slug),
          url: demoUrl(slug),
          subdomain: demoSubdomain(slug),
        })),
      );
    }

    const demoMatch = url.pathname.match(/^\/demos\/([^/]+)(\/.*)?$/);
    if (demoMatch) {
      return runDemo(request, env, demoMatch[1]!);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
