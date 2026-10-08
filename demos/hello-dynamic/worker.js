export default {
  async fetch(request) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "world";
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>hello-dynamic</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0e0e11; color: #c9c9c4; font-family: ui-sans-serif, system-ui, sans-serif; }
      main { margin: 1rem; padding: 1.5rem; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; background: #17171b; max-width: 34rem; }
      h1 { margin: 0.35rem 0 0.75rem; color: #e8e8e4; font-size: 1.75rem; letter-spacing: -0.03em; }
      .k { margin: 0; font-family: ui-monospace, monospace; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: #c2410c; }
      p { line-height: 1.5; overflow-wrap: anywhere; }
      code { color: #e2622e; }
      a { color: #e8e8e4; }
    </style>
  </head>
  <body>
    <main>
      <p class="k">What this shows</p>
      <h1>Hello, ${name}</h1>
      <p>The hub Worker Loader compiles this module at request time and serves it as an isolated Dynamic Worker. Nothing is stored.</p>
      <p>Try <code>?name=Ankur</code>.</p>
      <p><a href="https://theserverless.dev/contact">Contact</a></p>
    </main>
  </body>
</html>`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
