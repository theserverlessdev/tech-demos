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

function isTagBoundary(code: number): boolean {
  return code === 62 || code === 47 || code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/** Linear strip of hostile subtrees. Unclosed tags drop the remainder. */
export function dropHostileTrees(html: string, tags: readonly string[] = DROP_TAGS): string {
  let input = html;
  for (const tag of tags) {
    const open = `<${tag}`;
    const close = `</${tag}>`;
    const lower = input.toLowerCase();
    let out = "";
    let i = 0;
    while (i < input.length) {
      const start = lower.indexOf(open, i);
      if (start === -1) {
        out += input.slice(i);
        break;
      }
      const after = start + open.length;
      if (after < lower.length && !isTagBoundary(lower.charCodeAt(after))) {
        out += input.slice(i, after);
        i = after;
        continue;
      }
      out += input.slice(i, start);
      const end = lower.indexOf(close, after);
      if (end === -1) {
        i = input.length;
        break;
      }
      i = end + close.length;
    }
    input = out;
  }
  return input;
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
export function cleanMailHtml(html: string): { head: string; body: string } {
  const stripped = dropHostileTrees(html.replace(/<base\b[^>]*>/gi, ""));
  const doc = new DOMParser().parseFromString(stripped, "text/html");
  doc.querySelectorAll([...DROP_TAGS].join(",")).forEach((n) => n.remove());
  for (const node of doc.querySelectorAll<HTMLElement>("*")) {
    for (const attr of [...node.attributes]) {
      if (shouldDropAttr(attr.name)) node.removeAttribute(attr.name);
    }
    const href = node.getAttribute("href")?.trim() ?? "";
    if (href && !isSafeHref(href)) node.removeAttribute("href");
  }
  for (const link of doc.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>("a, area")) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
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
