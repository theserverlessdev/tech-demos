/** Matches PLAN.md / CONTRACT.md. Popups stay inside this opaque-origin frame. */
export const GADGET_IFRAME_SANDBOX = "allow-scripts";

/**
 * Injected before gadget `client.js`. Locks `window.open` (not writable, not
 * configurable) and turns in-frame link clicks into a parent `open-url` message.
 * Gadget code that runs later cannot `delete window.open` to restore the native.
 */
export function gadgetIsolationScript(): string {
  return `(() => {
  const send = (url) => {
    try { window.parent.postMessage({ type: "open-url", url: String(url ?? "") }, "*"); } catch {}
  };
  const blocked = function open(url) { send(url); return null; };
  Object.defineProperty(window, "open", { configurable: false, writable: false, value: blocked });
  for (const ev of ["pointerdown", "keydown"]) {
    document.addEventListener(ev, () => {
      try { window.parent.postMessage({ type: "user-activity" }, "*"); } catch {}
    }, true);
  }
  document.addEventListener("click", (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    let node = event.target;
    for (const item of path) {
      if (item && item.tagName === "A") { node = item; break; }
    }
    const a = node && node.closest ? node.closest("a") : null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return;
    if (/^javascript:/i.test(href)) { event.preventDefault(); return; }
    event.preventDefault();
    event.stopPropagation();
    send(a.href || href);
  }, true);
})();`;
}
