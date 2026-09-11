# Gadget contract

This contract matches the upstream Cloudflare OS gadget format, cut down for this demo.

## Files

Each blueprint lives in `src/blueprints/<id>/`:

| File | Purpose |
|---|---|
| `blueprint.json` | Manifest: `id`, `title`, `icon`, `description`, `bindings` (array, can be empty), `prompt` (one example request) |
| `server.js` | Durable Object class. Must `export class Gadget extends DurableObject` |
| `client.js` | Browser module that builds the whole UI. There is no `index.html` |
| `README.md` | Short description and a `## Methods` list. The agent reads this list to call methods |

`icon` is one of: `presentation`, `grid`, `palette`, `newspaper`, `sparkle`, `code`.

## server.js

```js
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.subscribers = new Set();
    // Private storage: this.ctx.storage.sql (SQLite) or this.ctx.storage.kv (sync KV).
  }

  async subscribe(callback) {
    const dup = callback.dup();
    this.subscribers.add(dup);
    dup.onRpcBroken(() => this.subscribers.delete(dup));
  }

  #broadcast(method, value) {
    for (const s of this.subscribers) s[method](value).catch(() => this.subscribers.delete(s));
  }
}
```

Rules:

- The gadget runs as a Durable Object **facet** in a Dynamic Worker. It has its own SQLite database.
- Store state in storage, not only in memory. The facet restarts when the code changes.
- `globalOutbound` is `null`. `fetch()` throws. Use bindings to reach the outside.
- Every public method is callable from the browser (`gadget.method()`) and from the agent (`callGadget`).
  Use only structured-cloneable, JSON-like values for arguments and return values.
- Validate every argument. Anyone with the workspace link can call a method.
- Keep state small (less than 200 KB).
- Do not name a method with a leading `__`. The platform reserves that prefix.

### Bindings (gatekeepers)

A binding exists in `this.env` only when `blueprint.json` lists it.

- `this.env.WEB.getJson(url)` returns the parsed JSON. The host must be on the allowlist
  (`hn.algolia.com`, `api.github.com`, `en.wikipedia.org`). Each call goes to the workspace approval queue.
  The call waits until a person approves it, and it throws `Error("Denied: ...")` if a person denies it.
- `this.env.AI.complete({ system, prompt, maxTokens })` returns a string. The platform meters the cost.

## client.js

`client.js` runs as a module script in `<iframe sandbox="allow-scripts">`. You can use top-level `await`.

These globals exist. Do not import or declare them:

| Global | Value |
|---|---|
| `gadget` | Cap'n Web stub to the `Gadget` Durable Object |
| `RpcTarget` | Cap'n Web `RpcTarget` class, for callback objects |
| `gadgetInfo` | `{ id, title, viewer: { name, color } }`. `viewer` is this browser tab |

Subscription pattern:

```js
class Listener extends RpcTarget {
  stateChanged(state) { render(state); }
}
render(await gadget.getState());
await gadget.subscribe(new Listener());
```

Rules:

- Build the DOM from JavaScript. Append to `document.body`.
- No `fetch`, no `alert`, no `confirm`, no `prompt`, no `window.open`, no external images or scripts. The CSP blocks them.
- Make the UI responsive. The iframe can be 320 px to 1100 px wide. The height fills the pane.
- Use the injected design tokens below. Do not hard-code another palette.
- Use `textContent` for user data. Do not put user data into `innerHTML`.

## Injected base CSS (Graphite and Ember)

The shell injects this before `client.js` runs. `<html>` has `data-theme="dark"` or `data-theme="light"`,
and the shell changes it live.

```css
:root, [data-theme="dark"] {
  --bg: #0e0e11; --surface: #16161a; --surface-2: #1d1d22; --border: rgba(255,255,255,.08);
  --border-strong: rgba(255,255,255,.16); --text: #c9c9c4; --text-strong: #e8e8e4; --muted: #8a8a85;
  --ember: #c2410c; --ember-2: #e2622e; --accent-text: #e2622e; --ember-soft: rgba(194,65,12,.14);
  --ok: #4d9e6a; --warn: #d19a2a; --danger: #d0533f;
}
[data-theme="light"] {
  --bg: #faf9f6; --surface: #ffffff; --surface-2: #f2f0ea; --border: rgba(23,23,26,.1);
  --border-strong: rgba(23,23,26,.2); --text: #3d3a34; --text-strong: #17171a; --muted: #6b675e;
  --ember: #b23a0a; --ember-2: #c2410c; --accent-text: #b23a0a; --ember-soft: rgba(178,58,10,.1);
}
:root {
  --font-heading: "Bricolage Grotesque", system-ui, sans-serif;
  --font-body: "Hanken Grotesk", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --radius-sm: 6px; --radius: 10px; --radius-lg: 14px;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font: 15px/1.5 var(--font-body); -webkit-font-smoothing: antialiased; }
h1, h2, h3 { font-family: var(--font-heading); color: var(--text-strong); letter-spacing: -0.02em; margin: 0; }
button { font: inherit; cursor: pointer; }
.btn { display: inline-flex; align-items: center; gap: .4em; padding: .45em .9em; border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong); background: transparent; color: var(--text-strong); font-weight: 600; font-size: 13px; }
.btn:hover { border-color: var(--ember); }
.btn-primary { background: var(--ember); border-color: var(--ember); color: #fff; }
.btn-primary:hover { background: var(--ember-2); border-color: var(--ember-2); }
.eyebrow { font: 500 11px/1 var(--font-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--accent-text); }
.chip { font: 12px/1 var(--font-mono); color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: .3em .7em; }
```

Style: flat ember accent, hairline borders, no gradients, no glow, no emoji.
