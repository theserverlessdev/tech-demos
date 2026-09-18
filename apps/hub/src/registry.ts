import type { DemoMeta } from "@tech-demos/shared";

export type DemoEntry = DemoMeta & {
  /** Raw Worker module source loaded into a Dynamic Worker (plain JS) */
  source: string;
};

const helloDynamicSource = `export default {
  async fetch(request) {
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

// cloudflare-os is a standalone Worker (Durable Objects, Workers AI, its own Worker Loader). A zone route
// sends /demos/cloudflare-os* to it before the hub sees the request. This source only runs if that route
// is missing, and it sends the visitor to the demo subdomain.
const cloudflareOsFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/cloudflare-os/, "") || "/";
    return Response.redirect("https://cloudflare-os.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// apollo-desk is a standalone Worker (Agents SDK Durable Object, Workers AI). Same pattern as cloudflare-os:
// the zone route wins, and this source only redirects if that route is missing.
const apolloDeskFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/apollo-desk/, "") || "/";
    return Response.redirect("https://apollo-desk.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// temp-email is a standalone Worker (Email Worker, D1, cron). Its home is email.lomvic.com, because
// the addresses live on that throwaway mail zone. The TSD hub route sends /demos/temp-email* to the Worker, which redirects there.
// This source only runs if that route is missing.
const tempEmailFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/temp-email/, "") || "/";
    return Response.redirect("https://email.lomvic.com" + rest + url.search, 302);
  },
};
`;

// resolve-hq is a standalone Worker (D1, R2, Queues, Workers AI). Same pattern as apollo-desk:
// the zone route wins, and this source only redirects if that route is missing.
const resolveHqFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/resolve-hq/, "") || "/";
    return Response.redirect("https://resolve-hq.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// goodvibes is a standalone Worker (Durable Objects + Static Assets). Same pattern as resolve-hq:
// the zone route wins, and this source only redirects if that route is missing.
const goodvibesFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/goodvibes/, "") || "/";
    return Response.redirect("https://goodvibes.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

export const demos: DemoEntry[] = [
  {
    slug: "goodvibes",
    title: "GoodVibes",
    description:
      "Ember Rush: a 75-second multiplayer orb hunt on a Durable Object WebSocket. Collect ember orbs, gold is +3, highest score wins. Hibernation + rate-limited room create. Inspired by goodvibes — original game, not a vendor of the kit.",
    tags: ["durable-objects", "websockets", "threejs", "game"],
    source: goodvibesFallbackSource,
  },
  {
    slug: "resolve-hq",
    title: "ResolveHQ",
    description:
      "A shared support inbox on Workers: D1 tickets, R2 attachments, a Queue-simulated inbound mail, and a Workers AI draft reply. A small slice of ResolveHQ — no tenancy, no Email Routing MX.",
    tags: ["d1", "r2", "queues", "workers-ai"],
    source: resolveHqFallbackSource,
  },
  {
    slug: "temp-email",
    title: "Temp email",
    description:
      "Disposable inboxes on email.lomvic.com. Mint a Turnstile-gated agent key, or use the short-TTL web UI. Self-host the same Email Worker + D1 on your Cloudflare account.",
    tags: ["email-workers", "email-routing", "d1", "cron", "agents"],
    source: tempEmailFallbackSource,
  },
  {
    slug: "apollo-desk",
    title: "Apollo desk",
    description:
      "A browser desk that talks to an Apollo-style brain. One Agents SDK Durable Object runs voice turns on Workers AI, keeps SQLite memory with vector recall, runs tools and timers, and calls an MCP server in the desk.",
    tags: ["agents-sdk", "durable-objects", "workers-ai", "voice", "mcp"],
    source: apolloDeskFallbackSource,
  },
  {
    slug: "cloudflare-os",
    title: "Cloudflare OS, sliced",
    description:
      "An agent workspace on Workers. Gadgets run in Dynamic Workers as Durable Object facets with private SQLite. Their sandboxed UIs use Cap'n Web RPC, and gatekeepers approve each outside read.",
    tags: ["dynamic-workers", "do-facets", "capnweb", "workers-ai", "agents"],
    source: cloudflareOsFallbackSource,
  },
  {
    slug: "hello-dynamic",
    title: "Hello Dynamic Worker",
    description: "Minimal HTML demo loaded via the hub Worker Loader.",
    tags: ["dynamic-workers", "starter"],
    source: helloDynamicSource,
  },
];

export function getDemo(slug: string): DemoEntry | undefined {
  return demos.find((d) => d.slug === slug);
}
