# Hello Dynamic Worker

A one-file HTML page the hub loads as a Dynamic Worker.

- **Live:** <https://tech-demos.theserverless.dev/demos/hello-dynamic>
- **Plan:** [PLAN.md](./PLAN.md)

## What this demonstrates

**Pattern.** The hub bundles `worker.js` as text. On the first request, the Worker Loader starts an isolate with id `hello-dynamic:<sha256 of compat date + source>` and reuses it while it stays warm. A source change gives a new id. The greeting reads `?name=` (HTML-escaped, capped at 64 Unicode code points). There is no Durable Object, no binding, and no stored state in the demo.

**What you can do**

- Open the page served by the loaded worker.
- Type a name in the form (or follow `?name=Ankur`) and see the greeting update.
- Refresh and watch the isolate request counter climb — that number is from the loaded module, not a static file on the hub.

**What you could build**

- A gallery that loads a snippet without a separate Worker deploy (load the source from KV or R2 instead of bundling it).
- A preview of generated worker code.
- A check that the loader path works before you add bindings.

**Limits**

- This demo cannot persist anything, call Workers AI, or open a WebSocket.
- It cannot make outbound requests. The hub passes `globalOutbound: null`, so `fetch()` throws.
- The module is plain JavaScript imported by the hub as a Text module. `?name=` is HTML-escaped and capped at 64 Unicode code points.
- The demo stores nothing; the hub's Workers Logs keep the request URL for up to 7 days.
