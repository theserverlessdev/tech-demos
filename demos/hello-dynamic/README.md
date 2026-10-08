# Hello Dynamic Worker

A one-file HTML page the hub loads as a Dynamic Worker.

- **Live:** <https://tech-demos.theserverless.dev/demos/hello-dynamic>
- **Plan:** [PLAN.md](./PLAN.md)

## What this demonstrates

**Pattern.** The hub Worker Loader compiles `worker.js` at request time and serves it as an isolated Dynamic Worker. The greeting reads `?name=`. There is no Durable Object, no binding, and no stored state.

**What you can do**

- Open the page served by the loaded worker.
- Change `?name=` and see the greeting update.
- Confirm the HTML comes from that worker, not a static file on the hub.

**What you could build**

- A gallery that loads a snippet without a separate Worker deploy.
- A preview of generated worker code.
- A check that the loader path works before you add bindings.

**Limits**

- This demo cannot persist anything, call Workers AI, or open a WebSocket.
- The module is plain JavaScript inlined in the hub registry. It is the fallback when the demo is not a standalone Worker.
