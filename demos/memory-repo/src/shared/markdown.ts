/** Escape first, then apply a small markdown subset. The result is safe to assign to innerHTML. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inline(raw: string): string {
  let html = escapeHtml(raw);
  html = html.replace(
    /\[([^\]]+)\]\(((?:people|preferences|projects|MEMORY)\.md)\)/g,
    (_match, label: string, href: string) => `<a href="#file-${href}">${label}</a>`,
  );
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return html;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (!list) return;
    out.push(`<ul>${list.join("")}</ul>`);
    list = null;
  };
  for (const line of lines) {
    const item = /^- (.*)$/.exec(line);
    if (item) {
      list ??= [];
      list.push(`<li>${inline(item[1] ?? "")}</li>`);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? "#").length + 1, 4);
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join("");
}
