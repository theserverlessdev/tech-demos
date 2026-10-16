/** Exact string match only. No prefix, query extras, or trailing-slash folding. */
export function redirectUriAllowed(redirectUri: string, registered: readonly string[]): boolean {
  if (!redirectUri || registered.length === 0) return false;
  return registered.some((allowed) => allowed === redirectUri);
}

export function parseRedirectUris(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}
