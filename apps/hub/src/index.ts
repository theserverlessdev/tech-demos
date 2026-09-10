import { demoPath } from "@tech-demos/shared";
import { demos, getDemo } from "./registry";

export interface Env {
  LOADER: WorkerLoader;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/demos") {
      return Response.json(
        demos.map(({ slug, title, description, tags }) => ({
          slug,
          title,
          description,
          tags,
          href: demoPath(slug),
        })),
      );
    }

    const demoMatch = url.pathname.match(/^\/demos\/([^/]+)(\/.*)?$/);
    if (demoMatch) {
      const slug = demoMatch[1]!;
      const demo = getDemo(slug);
      if (!demo) {
        return new Response(`Unknown demo: ${slug}`, { status: 404 });
      }

      // Stable ID so repeat hits to the same demo code count as one Dynamic Worker / day.
      const worker = env.LOADER.get(slug, () => ({
        compatibilityDate: "2026-09-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "worker.js",
        modules: {
          "worker.js": demo.source,
        },
        // Demos start locked down; open egress per-demo later if needed.
        globalOutbound: null,
      }));

      const entry = worker.getEntrypoint();
      return entry.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
