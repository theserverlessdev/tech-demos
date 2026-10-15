function isTagBoundary(code: number): boolean {
  return code === 62 || code === 47 || code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/** ASCII case-insensitive indexOf. Avoids `toLowerCase()` length changes (İ, ß) desyncing indices. */
export function indexOfAsciiIgnoreCase(haystack: string, needle: string, from = 0): number {
  const n = needle.length;
  if (n === 0) return from;
  outer: for (let i = Math.max(0, from); i <= haystack.length - n; i++) {
    for (let j = 0; j < n; j++) {
      let hc = haystack.charCodeAt(i + j);
      let nc = needle.charCodeAt(j);
      if (hc >= 65 && hc <= 90) hc += 32;
      if (nc >= 65 && nc <= 90) nc += 32;
      if (hc !== nc) continue outer;
    }
    return i;
  }
  return -1;
}

/** Drop `<tag>…</tag>` blocks with indexOf. Unclosed tags drop the remainder. Linear in input length. */
export function stripAsciiTagTrees(html: string, tags: readonly string[]): string {
  let input = html;
  for (const tag of tags) {
    const open = `<${tag}`;
    const close = `</${tag}>`;
    let out = "";
    let i = 0;
    while (i < input.length) {
      const start = indexOfAsciiIgnoreCase(input, open, i);
      if (start === -1) {
        out += input.slice(i);
        break;
      }
      const after = start + open.length;
      if (after < input.length && !isTagBoundary(input.charCodeAt(after))) {
        out += input.slice(i, after);
        i = after;
        continue;
      }
      out += input.slice(i, start);
      const end = indexOfAsciiIgnoreCase(input, close, after);
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

export function countSqlPlaceholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}
