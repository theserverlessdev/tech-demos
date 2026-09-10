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
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #e8eefc; }
      main { padding: 2rem; border: 1px solid #2a3555; border-radius: 16px; background: #121a33; max-width: 32rem; }
      code { color: #9ad1ff; }
    </style>
  </head>
  <body>
    <main>
      <h1>Hello, ${name}</h1>
      <p>This demo runs as a <code>Dynamic Worker</code> loaded by the hub at request time.</p>
      <p>Try <code>?name=Ankur</code>.</p>
    </main>
  </body>
</html>`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
