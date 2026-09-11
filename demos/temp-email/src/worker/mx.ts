import type { MxStatus } from "../shared/types";

const CACHE_MS = 5 * 60_000;
let cached: { domain: string; status: MxStatus } | null = null;

/**
 * Reads the public MX records for the mail domain through DNS over HTTPS. The UI uses this to tell the
 * visitor whether real mail can arrive yet. An isolate-level cache keeps this to one lookup each 5 minutes.
 */
export async function mxStatus(domain: string): Promise<MxStatus> {
  if (cached && cached.domain === domain && Date.now() - cached.status.checkedAt < CACHE_MS) return cached.status;
  let records: string[] = [];
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: "application/dns-json" },
    });
    if (res.ok) {
      const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
      records = (body.Answer ?? []).filter((a) => a.type === 15).map((a) => a.data);
    }
  } catch (err) {
    console.warn(JSON.stringify({ event: "mx_lookup_failed", domain, error: String(err) }));
  }
  const status: MxStatus = {
    live: records.some((r) => /\.mx\.cloudflare\.net\.?$/i.test(r)),
    records,
    checkedAt: Date.now(),
  };
  cached = { domain, status };
  return status;
}
