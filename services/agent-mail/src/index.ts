import { Hono } from "hono";
import { admin } from "./admin";
import { api, type AppEnv } from "./api";
import { cleanupSpam, handleInbound } from "./inbound";
import { publicHome, simplePage } from "./panel";
import { HttpError, logEvent } from "./util";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "no-referrer");
  c.res.headers.set("x-frame-options", "DENY");
  const type = c.res.headers.get("content-type") ?? "";
  if (type.includes("text/html")) {
    c.res.headers.set(
      "content-security-policy",
      "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  }
  if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
});

app.onError((err, c) => {
  const http = err instanceof HttpError ? err : null;
  const status = http?.status ?? 500;
  const code = http?.code ?? "internal";
  const message = http?.message ?? "The server failed. Try again.";
  if (!http) logEvent("api_error", { error: err instanceof Error ? err.name : "error" });
  const accept = c.req.header("accept") ?? "";
  const json = (c.req.header("content-type") ?? "").includes("application/json") || accept.includes("application/json");
  if (!json && (c.req.path === "/" || c.req.path.startsWith("/admin"))) {
    return c.html(simplePage("Agent Mail", message), status as 403);
  }
  return c.json({ error: { code, message } }, status as 500);
});

app.get("/health", (c) => c.json({ ok: true, service: "agent-mail", domain: c.env.MAIL_DOMAIN }));
app.get("/", (c) => c.html(publicHome(c.env.MAIL_DOMAIN)));
app.route("/", api);
app.route("/", admin);

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  email: (message, env, ctx) => handleInbound(message, env, ctx),
  async scheduled(_controller, env) {
    const removed = await cleanupSpam(env);
    logEvent("cleanup", removed);
  },
} satisfies ExportedHandler<Env>;
