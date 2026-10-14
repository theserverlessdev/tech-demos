function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

let hits = 0;

export default {
  async fetch(request) {
    hits += 1;
    const url = new URL(request.url);
    const provided = (url.searchParams.get("name") ?? "").trim();
    const raw = provided || "world";
    const display = Array.from(raw).slice(0, 64).join("");
    const name = escapeHtml(display);
    const inputValue = provided ? escapeHtml(Array.from(provided).slice(0, 64).join("")) : "";
    const loaderId = escapeHtml(request.headers.get("x-dynamic-worker") ?? "");
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'" />
    <title>hello-dynamic</title>
    <style>
      :root { color-scheme: dark; }
      *, *::before, *::after { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; background: #0e0e11; color: #c9c9c4; font-family: system-ui, -apple-system, sans-serif; overflow-x: hidden; }
      main { margin: 1rem; padding: 1.5rem; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; background: #17171b; width: min(34rem, calc(100% - 2rem)); }
      h1 { margin: 0.35rem 0 0.75rem; color: #e8e8e4; font-size: 1.75rem; letter-spacing: -0.03em; overflow-wrap: anywhere; }
      .k { margin: 0; font-family: ui-monospace, monospace; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: #c2410c; }
      p { line-height: 1.5; overflow-wrap: anywhere; }
      code { color: #e2622e; overflow-wrap: anywhere; }
      form { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0; }
      input, button { font: inherit; font-size: 16px; min-height: 44px; border-radius: 0.5rem; }
      input { flex: 1 1 12rem; min-width: 0; padding: 0 0.85rem; background: #0e0e11; color: #e8e8e4; border: 1px solid rgba(255,255,255,0.08); }
      button { padding: 0 1rem; background: #c2410c; color: #fff; border: none; font-weight: 600; cursor: pointer; }
      button:hover { background: #e2622e; }
      a { color: #e8e8e4; display: inline-flex; align-items: center; min-height: 44px; }
      a:hover { color: #e2622e; }
      .nav { display: flex; flex-wrap: wrap; gap: 0.75rem 1.25rem; }
    </style>
  </head>
  <body>
    <main>
      <p class="k">What this shows</p>
      <h1>Hello, ${name}</h1>
      <p>The hub bundles <code>worker.js</code> as text. On the first request, the Worker Loader starts an isolate with id <code>hello-dynamic:&lt;sha256 of compat date + source&gt;</code> and reuses it while it stays warm. A source change gives a new id.</p>
      <p>The demo stores nothing; the hub's Workers Logs keep the request URL for up to 7 days.</p>
      <form method="get">
        <input name="name" maxlength="64" aria-label="Name" placeholder="world" value="${inputValue}" autocomplete="nickname" />
        <button type="submit">Greet</button>
      </form>
      <p>Try <a href="?name=Ankur"><code>?name=Ankur</code></a>. This isolate has served <strong>request #${hits}</strong> — refresh to see it climb while the isolate stays warm. That counter lives in this module, so the HTML is not a static file on the hub.</p>
      <p>Loader id: <code>${loaderId}</code> — <code>slug:sha256(compatDate + "\\n" + source)</code>.</p>
      <p>It cannot make outbound requests. The hub passes <code>globalOutbound: null</code>, so <code>fetch()</code> throws.</p>
      <p class="nav"><a href="https://tech-demos.theserverless.dev/">← All demos</a><a href="https://theserverless.dev/contact">Contact</a></p>
    </main>
  </body>
</html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
