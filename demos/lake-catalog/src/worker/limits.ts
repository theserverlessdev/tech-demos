export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

/** IPv4 stays as-is. IPv6 is keyed on its /64 so one network shares a bucket. */
export function rateLimitKey(ip: string): string {
  const raw = (ip.split("%")[0] ?? ip).trim();
  if (!raw) return "local";
  if (!raw.includes(":")) return raw;
  if (raw.includes(".")) {
    const mapped = raw.slice(raw.lastIndexOf(":") + 1);
    return mapped || raw;
  }
  const [head = "", tail = ""] = raw.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const full = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  while (full.length < 8) full.push("0");
  return `${full
    .slice(0, 4)
    .map((part) => part.padStart(4, "0").toLowerCase())
    .join(":")}::/64`;
}
