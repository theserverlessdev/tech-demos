/** IPv4 stays as-is. IPv6 is keyed on its /64 so rotating addresses in one network share a bucket. */
export function networkKey(ip: string): string {
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

export type GadgetLimitKey = { key: string; message: string };

/** Per-IP and per-workspace keys on the same GADGET_LIMIT binding. */
export function gadgetLimitKeys(ip: string, workspaceId: string): GadgetLimitKey[] {
  return [
    {
      key: networkKey(ip || "unknown"),
      message: "Too many gadget calls from your network. Wait a few seconds, then try again.",
    },
    {
      key: `ws:${workspaceId || "unknown"}`,
      message: "Too many gadget calls in this workspace. Wait a few seconds, then try again.",
    },
  ];
}

export async function assertGadgetLimit(limiter: RateLimit, ip: string, workspaceId: string): Promise<void> {
  for (const { key, message } of gadgetLimitKeys(ip, workspaceId)) {
    const { success } = await limiter.limit({ key });
    if (!success) throw new Error(message);
  }
}
