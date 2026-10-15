const VISITOR = /^[a-f0-9]{32}$/;

export const VISITOR_COOKIE = "mr_vid";

/** Read the visitor id. A malformed percent-encoding is treated as missing. */
export function readVisitorId(header: string, cookieName = VISITOR_COOKIE): string | null {
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== cookieName) continue;
    let value = rest.join("=");
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return VISITOR.test(value) ? value : null;
  }
  return null;
}
