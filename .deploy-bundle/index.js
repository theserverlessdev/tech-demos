var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../packages/shared/src/index.ts
var HUB_HOST = "tech-demos.theserverless.dev";
function demoPath(slug) {
  return `/demos/${slug}`;
}
__name(demoPath, "demoPath");
function demoSubdomain(slug, proto = "https") {
  return `${proto}://${slug}.${HUB_HOST}`;
}
__name(demoSubdomain, "demoSubdomain");
function demoUrl(slug, proto = "https") {
  return `${proto}://${HUB_HOST}${demoPath(slug)}`;
}
__name(demoUrl, "demoUrl");

// src/registry.ts
var helloDynamicSource = `export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "world";
    const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>hello-dynamic</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #e8eefc; }
      main { padding: 2rem; border: 1px solid #2a3555; border-radius: 16px; background: #121a33; max-width: 32rem; }
      code { color: #9ad1ff; }
    </style>
  </head>
  <body>
    <main>
      <h1>Hello, \${name}</h1>
      <p>This demo runs as a <code>Dynamic Worker</code> loaded by the hub at request time.</p>
      <p>Try <code>?name=Ankur</code>.</p>
    </main>
  </body>
</html>\`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
`;
var demos = [
  {
    slug: "hello-dynamic",
    title: "Hello Dynamic Worker",
    description: "Minimal HTML demo loaded via the hub Worker Loader.",
    tags: ["dynamic-workers", "starter"],
    source: helloDynamicSource
  }
];
function getDemo(slug) {
  return demos.find((d) => d.slug === slug);
}
__name(getDemo, "getDemo");

// src/index.ts
function slugFromHost(hostname) {
  const suffix = `.${HUB_HOST}`;
  if (hostname.endsWith(suffix)) {
    const slug = hostname.slice(0, -suffix.length);
    if (slug && !slug.includes(".")) return slug;
  }
  return null;
}
__name(slugFromHost, "slugFromHost");
async function runDemo(request, env, slug) {
  const demo = getDemo(slug);
  if (!demo) {
    return new Response(`Unknown demo: ${slug}`, { status: 404 });
  }
  const worker = env.LOADER.get(slug, () => ({
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "worker.js",
    modules: {
      "worker.js": demo.source
    },
    // Demos start locked down; open egress per-demo later if needed.
    globalOutbound: null
  }));
  return worker.getEntrypoint().fetch(request);
}
__name(runDemo, "runDemo");
var index_default = {
  async fetch(request, env) {
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
          subdomain: demoSubdomain(slug)
        }))
      );
    }
    const demoMatch = url.pathname.match(/^\/demos\/([^/]+)(\/.*)?$/);
    if (demoMatch) {
      return runDemo(request, env, demoMatch[1]);
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
