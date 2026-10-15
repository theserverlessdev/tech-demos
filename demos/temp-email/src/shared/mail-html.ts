import { stripAsciiTagTrees } from "./scan";

const SAFE_LINK = /^(https?:|mailto:)/i;

export const DROP_TAGS = [
  // Namespace confusion (mXSS) first, so an unclosed <meta> inside <math> cannot eat the rest.
  "math",
  "svg",
  "script",
  "noscript",
  "meta",
  "base",
  "link",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "form",
] as const;

/** Linear strip of hostile subtrees. Unclosed tags drop the remainder. ASCII case-fold only. */
export function dropHostileTrees(html: string, tags: readonly string[] = DROP_TAGS): string {
  return stripAsciiTagTrees(html, tags);
}

export function isSafeHref(href: string): boolean {
  return SAFE_LINK.test(href);
}

export function shouldDropAttr(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("on") || n === "xlink:href" || (n.includes(":href") && n !== "href");
}

/**
 * Cleans untrusted mail HTML before it goes into the frame. DOMParser builds an inert document: no script
 * runs and no image loads. Links keep only http, https, and mailto, because the frame lets a clicked link
 * open a normal tab, and a data: or javascript: URL must never reach that tab.
 *
 * This is defense in depth. The sandbox without allow-scripts is the real boundary. Re-serializing into
 * srcdoc parses the markup a second time (mXSS). Dropping math/svg and checking href on every element
 * reduces that. A future allow-scripts would still be unsafe.
 */
type AttrNode = {
  attributes: ArrayLike<{ name: string }>;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
  remove?: () => void;
};

type MailDom = {
  querySelectorAll(selector: string): ArrayLike<AttrNode>;
  head?: { querySelectorAll(selector: string): ArrayLike<{ outerHTML: string }> } | null;
  body?: { innerHTML: string } | null;
};

/** DOM pass after the linear strip. Exported so tests can run it without DOMParser. */
export function scrubMailDom(doc: MailDom): void {
  const dropSel = Array.from(DROP_TAGS).join(",");
  for (const node of Array.from(doc.querySelectorAll(dropSel))) node.remove?.();
  for (const node of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(node.attributes)) {
      if (shouldDropAttr(attr.name)) node.removeAttribute(attr.name);
    }
    const href = node.getAttribute("href")?.trim() ?? "";
    if (href && !isSafeHref(href)) node.removeAttribute("href");
  }
  for (const link of Array.from(doc.querySelectorAll("a, area"))) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
}

export function cleanMailHtml(html: string): { head: string; body: string } {
  const stripped = dropHostileTrees(html.replace(/<base\b[^>]*>/gi, ""));
  const doc = new DOMParser().parseFromString(stripped, "text/html");
  scrubMailDom(doc);
  const headStyles = doc.head ? [...doc.head.querySelectorAll("style")].map((n) => n.outerHTML).join("") : "";
  return { head: headStyles, body: doc.body?.innerHTML ?? "" };
}

export function frameCsp(remote: boolean): string {
  const img = remote ? "data: cid: https: http:" : "data: cid:";
  return `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:${remote ? " https:" : ""}; form-action 'none'`;
}

/**
 * The HTML part renders in a sandboxed srcdoc frame: no scripts, an opaque origin, and a CSP that blocks
 * remote loads until the visitor allows them. Sandbox without allow-scripts disables meta refresh and JS.
 * The cleaner cannot be trusted alone after a second parse.
 */
export function frameDocument(html: string, remote: boolean): string {
  const mail = cleanMailHtml(html);
  const csp = frameCsp(remote);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>body{margin:0;padding:16px;font-family:system-ui,sans-serif;color:#17171a;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style>${mail.head}</head><body>${mail.body}</body></html>`;
}
