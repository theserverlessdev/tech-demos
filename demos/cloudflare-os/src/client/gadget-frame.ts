import { RpcTarget, newMessagePortRpcSession } from "capnweb";
// The build copies capnweb's ESM bundle here, so the shell can embed it in each sandboxed frame.
import CAPNWEB_SOURCE from "./gen/capnweb.txt";

/** Same base CSS the gadget contract documents (src/blueprints/CONTRACT.md). */
export const GADGET_BASE_CSS = `:root, [data-theme="dark"] {
  --bg: #0e0e11; --surface: #16161a; --surface-2: #1d1d22; --border: rgba(255,255,255,.08);
  --border-strong: rgba(255,255,255,.16); --text: #c9c9c4; --text-strong: #e8e8e4; --muted: #8a8a85;
  --ember: #c2410c; --ember-2: #e2622e; --accent-text: #e2622e; --ember-soft: rgba(194,65,12,.14);
  --ok: #4d9e6a; --warn: #d19a2a; --danger: #d0533f; color-scheme: dark;
}
[data-theme="light"] {
  --bg: #faf9f6; --surface: #ffffff; --surface-2: #f2f0ea; --border: rgba(23,23,26,.1);
  --border-strong: rgba(23,23,26,.2); --text: #3d3a34; --text-strong: #17171a; --muted: #6b675e;
  --ember: #b23a0a; --ember-2: #c2410c; --accent-text: #b23a0a; --ember-soft: rgba(178,58,10,.1);
  --ok: #2f7d4f; --warn: #a86f0a; --danger: #b43d2b; color-scheme: light;
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
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary { background: var(--ember); border-color: var(--ember); color: #fff; }
.btn-primary:hover { background: var(--ember-2); border-color: var(--ember-2); }
.eyebrow { font: 500 11px/1 var(--font-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--accent-text); }
.chip { font: 12px/1 var(--font-mono); color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: .3em .7em; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--surface-2); border-radius: 10px; border: 2px solid var(--bg); }`;

const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Hanken+Grotesk:wght@400..700&family=JetBrains+Mono:wght@400;500&display=swap";

// Upstream CSP, plus Google Fonts so gadgets can use the brand type. connect-src stays 'none'.
const CSP = [
  "default-src 'none'",
  "frame-src 'none'",
  "script-src data: 'unsafe-inline'",
  "style-src data: 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src data:",
  "media-src data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "connect-src 'none'",
].join("; ");

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

let capnwebDataUrl: string | null = null;
function capnwebUrl(): string {
  capnwebDataUrl ??= `data:text/javascript;charset=utf-8;base64,${toBase64(`//# sourceURL=capnweb.js\n${CAPNWEB_SOURCE}`)}`;
  return capnwebDataUrl;
}

export type FrameInfo = { id: string; title: string; viewer: { name: string; color: string } };

function injectedPrefix(info: FrameInfo): string {
  const json = JSON.stringify(info).replace(/</g, "\\u003c");
  return `//# sourceURL=client.js
import { RpcTarget, newMessagePortRpcSession } from "${capnwebUrl()}";

const gadgetInfo = Object.freeze(${json});
let gadget;
{
  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage("handshake", "*", [port2]);
  gadget = newMessagePortRpcSession(port1);
}

for (const level of ["info", "log", "warn", "error"]) {
  const original = console[level];
  console[level] = (...args) => {
    original.apply(console, args);
    try {
      const message = args.map((a) => { if (typeof a === "string") return a; try { return JSON.stringify(a); } catch { return String(a); } }).join(" ");
      window.parent.postMessage({ type: "console", level, message }, "*");
    } catch {}
  };
}
window.addEventListener("error", (e) => window.parent.postMessage({ type: "console", level: "error", message: "Uncaught " + (e.error?.stack || e.message) }, "*"));
window.addEventListener("unhandledrejection", (e) => window.parent.postMessage({ type: "console", level: "error", message: "Unhandled rejection: " + (e.reason?.message || String(e.reason)) }, "*"));
window.addEventListener("message", (e) => {
  if (e.source === window.parent && e.data && e.data.type === "theme") document.documentElement.setAttribute("data-theme", e.data.theme);
});
window.open = () => null;
`;
}

export function sandboxHtml(jsCode: string, info: FrameInfo, theme: string): string {
  const script = encodeURIComponent(injectedPrefix(info) + "\n" + jsCode);
  return `<!DOCTYPE html>
<html data-theme="${theme === "light" ? "light" : "dark"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<link rel="stylesheet" href="${FONTS}">
<style>${GADGET_BASE_CSS}</style>
</head>
<body>
<script type="module" src="data:text/javascript;charset=utf-8,${script}"></script>
</body>
</html>`;
}

type GadgetStub = Record<string, (...args: unknown[]) => Promise<unknown>> & Disposable;

export type CallTrace = (gadgetId: string, method: string, ms: number, ok: boolean) => void;

/**
 * Bridges one sandboxed frame to the gadget's facet. The frame gets a MessagePort session. Its root
 * object is a forwarding target: each method call goes to the Cap'n Web stub from `connectToGadget`,
 * which the Worker and the Workspace DO forward to the facet.
 */
export class FrameBridge {
  #session: Disposable | null = null;
  #stub: GadgetStub | null = null;

  constructor(
    readonly gadgetId: string,
    private connect: () => Promise<GadgetStub>,
    private trace: CallTrace,
  ) {}

  async handshake(port: MessagePort) {
    this.dispose();
    const stub = await this.connect();
    this.#stub = stub;
    const gadgetId = this.gadgetId;
    const trace = this.trace;
    const target = new Proxy(new RpcTarget() as unknown as Record<string | symbol, unknown>, {
      get: (obj, prop, receiver) => {
        if (typeof prop === "symbol" || prop in obj) return Reflect.get(obj, prop, receiver);
        return (...args: unknown[]) => {
          const current = this.#stub;
          if (!current) return Promise.reject(new Error("The gadget is disconnected."));
          const started = performance.now();
          const result = current[prop]!(...args);
          Promise.resolve(result).then(
            () => trace(gadgetId, prop, performance.now() - started, true),
            () => trace(gadgetId, prop, performance.now() - started, false),
          );
          return result;
        };
      },
    });
    this.#session = newMessagePortRpcSession(port, target) as unknown as Disposable;
  }

  dispose() {
    try {
      this.#session?.[Symbol.dispose]();
    } catch {}
    try {
      this.#stub?.[Symbol.dispose]();
    } catch {}
    this.#session = null;
    this.#stub = null;
  }
}
