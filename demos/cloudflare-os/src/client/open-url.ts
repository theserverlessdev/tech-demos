/**
 * URLs a sandboxed gadget may ask the parent shell to open. The iframe itself
 * has no `allow-popups`, so Headlines links travel here over postMessage.
 */
export function safeGadgetOpenUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
