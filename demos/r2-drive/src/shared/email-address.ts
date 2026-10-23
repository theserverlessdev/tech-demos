import { DISPOSABLE_LIST } from "./disposable-list";

/** Domains this repo hands out, plus anything that should never receive a magic link. */
const LOCAL_DENY = ["lomvic.com"];

let disposable: Set<string> | null = null;

export function disposableDomains(): Set<string> {
  if (disposable) return disposable;
  const set = new Set<string>();
  for (const line of DISPOSABLE_LIST.split("\n")) {
    const domain = line.trim().toLowerCase();
    if (!domain || domain.startsWith("#")) continue;
    set.add(domain);
  }
  disposable = set;
  return set;
}

/**
 * Lowercase, strip +tags, and remove dots on gmail.com / googlemail.com.
 * Returns null when the address is not a single mailbox we can send to.
 */
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254 || /[\s\u0000-\u001f]/.test(trimmed)) return null;
  const at = trimmed.indexOf("@");
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return null;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  if (!local || local.length > 64) return null;
  if (!/^[a-z0-9!#$%&'*/=?^_`{|}~.-]+$/.test(local)) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/.test(domain)) return null;
  if (domain.includes("..") || domain.startsWith("-") || domain.endsWith("-")) return null;
  return `${local}@${domain}`;
}

/**
 * The vendored list plus `LOCAL_DENY`. A hit on the domain or any parent
 * (a.mailinator.com, email.lomvic.com) is enough. The list is still a soft signal.
 */
export function isDisposableEmail(normalized: string): boolean {
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  const listed = disposableDomains();
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join(".");
    if (listed.has(suffix) || LOCAL_DENY.includes(suffix)) return true;
  }
  return false;
}
