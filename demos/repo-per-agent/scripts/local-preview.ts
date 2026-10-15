// Local preview: real UI + fake Artifacts + scripted Workers AI. No paid calls.
import { join } from "node:path";
import { handleApi, HttpError } from "../src/worker/api";
import { DUMMY, makeHarness } from "../test/harness";

const port = Number(process.env.PORT || 8787);
const publicDir = join(import.meta.dir, "../public");

const harness = await makeHarness();
const env = harness.env;

function contentType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path === "/demos/repo-per-agent") {
      url.pathname = "/demos/repo-per-agent/";
      return Response.redirect(url.toString(), 308);
    }
    if (path.startsWith("/demos/repo-per-agent/")) path = path.slice("/demos/repo-per-agent".length);
    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (err) {
        if (err instanceof HttpError) {
          return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
        }
        return Response.json({ error: { code: "internal", message: "The server failed. Try again." } }, { status: 500 });
      }
    }
    if (path === "/" || path === "") path = "/index.html";
    const file = Bun.file(join(publicDir, path));
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, { headers: { "content-type": contentType(path) } });
  },
});

console.log(`Local preview on http://127.0.0.1:${server.port}`);
console.log("Fake Artifacts + scripted GLM reply. Dummy Turnstile token:", DUMMY);
console.log("This process does not call Workers AI or the tech-demos namespace.");
