export function clientBase(pathname: string): string {
  if (pathname === "/demos/pairlane" || pathname.startsWith("/demos/pairlane/")) return "/demos/pairlane";
  return "";
}

export function roomLink(origin: string, base: string, id: string): string {
  const root = origin.replace(/\/$/, "");
  return `${root}${base}/?r=${id}`;
}

export function socketUrl(protocol: string, host: string, base: string, id: string, cid: string): string {
  const ws = protocol === "https:" ? "wss:" : "ws:";
  return `${ws}//${host}${base}/ws/${id}?cid=${encodeURIComponent(cid)}`;
}
