/** Encode text so it can sit inside HTML. Highlights use this before innerHTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function cleanText(value: string): string {
  return value.replace(/\u0000/g, "");
}
