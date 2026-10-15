// Local static preview: bun run scripts/preview.ts [port]
// Serves public/ with the same CSP and path rules as the Worker. No Durable Objects.
import { PAGE_CSP, isStaticAssetPath } from "../src/worker/gates";
import { TURNSTILE_TEST_SITE_KEY } from "../src/worker/turnstile";

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8787);
const root = new URL("../public/", import.meta.url).pathname;

function headers(html: boolean): Headers {
  const h = new Headers();
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("x-frame-options", "DENY");
  if (html) h.set("content-security-policy", PAGE_CSP);
  return h;
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path === "/demos/apollo-desk") return Response.redirect(`${url.origin}/demos/apollo-desk/`, 308);
    if (path.startsWith("/demos/apollo-desk/")) path = path.slice("/demos/apollo-desk".length) || "/";
    if (path.startsWith("/agents/")) return new Response("Unknown desk", { status: 404 });
    if (path === "/api/health") {
      return Response.json({
        ok: true,
        model: "@cf/zai-org/glm-5.3-flash",
        turnstileSiteKey: TURNSTILE_TEST_SITE_KEY,
        testSiteKey: true,
        tools: [],
      });
    }
    if (!isStaticAssetPath(path)) return new Response("Not found", { status: 404, headers: headers(false) });
    const filePath = path === "/" ? `${root}index.html` : `${root}${path.slice(1)}`;
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("Not found", { status: 404, headers: headers(false) });
    const html = file.type.startsWith("text/html") || path === "/" || path === "/index.html";
    return new Response(file, { headers: headers(html) });
  },
});

console.log(`preview http://127.0.0.1:${port}/`);
