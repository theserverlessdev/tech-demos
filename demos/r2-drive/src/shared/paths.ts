import { DRIVE_ID_RE } from "./constants";

const BASE = "/demos/r2-drive";

export function basePrefix(pathname: string): string {
  if (pathname === BASE || pathname.startsWith(`${BASE}/`)) return BASE;
  return "";
}

/** Strip the hub prefix so routes can be written once. */
export function stripBase(url: URL): { url: URL; base: string } {
  const base = basePrefix(url.pathname);
  if (!base) return { url, base: "" };
  const next = new URL(url.href);
  next.pathname = url.pathname.slice(base.length) || "/";
  return { url: next, base };
}

/**
 * Decode one URL path under a drive mount.
 * Returns the relative key, or null when the path escapes the prefix.
 */
export function confinePath(suffix: string): string | null {
  if (suffix === "" || suffix === "/") return "";
  if (!suffix.startsWith("/")) return null;
  const trimmed = suffix.endsWith("/") ? suffix.slice(0, -1) : suffix;
  if (trimmed === "") return "";
  const parts = trimmed.slice(1).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (
      decoded === "" ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      return null;
    }
    out.push(decoded);
  }
  return out.join("/");
}

export function safeRelativeKey(key: string): boolean {
  if (key === "") return true;
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) return false;
  return key.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export type DavTarget = {
  driveId: string;
  key: string;
  mountPath: string;
};

export function splitDavPath(pathname: string): DavTarget | "bad" | null {
  const base = basePrefix(pathname);
  const rest = base ? pathname.slice(base.length) || "/" : pathname;
  if (!rest.startsWith("/dav/") && rest !== "/dav") return null;
  const match = /^\/dav\/(drv_[a-f0-9]{32})(\/.*)?$/.exec(rest);
  if (!match) return "bad";
  const driveId = match[1] ?? "";
  if (!DRIVE_ID_RE.test(driveId)) return "bad";
  const key = confinePath(match[2] ?? "/");
  if (key === null) return "bad";
  return { driveId, key, mountPath: `${base}/dav/${driveId}` };
}

/** Destination must be the same origin and under the same mount. */
export function destinationKey(destination: string, requestUrl: string, mountPath: string): string | null {
  if (destination.length === 0 || destination.length > 2048) return null;
  let dest: URL;
  let req: URL;
  try {
    req = new URL(requestUrl);
    dest = new URL(destination, requestUrl);
  } catch {
    return null;
  }
  if (dest.origin !== req.origin) return null;
  if (dest.username || dest.password) return null;
  if (dest.pathname !== mountPath && !dest.pathname.startsWith(`${mountPath}/`)) return null;
  return confinePath(dest.pathname.slice(mountPath.length) || "/");
}

export function parentKey(key: string): string {
  if (!key.includes("/")) return "";
  return key.slice(0, key.lastIndexOf("/"));
}

export function encodeKey(key: string): string {
  if (!key) return "";
  return key.split("/").map(encodeURIComponent).join("/");
}

export function resourceHref(mountPath: string, key: string, isCollection: boolean): string {
  if (!key) return `${mountPath}/`;
  return `${mountPath}/${encodeKey(key)}${isCollection ? "/" : ""}`;
}
