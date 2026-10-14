export function isLocalEnv(env: Env): boolean {
  return `${env.ENVIRONMENT}` === "local";
}

/** REPLACE_ME and empty site keys mean Turnstile (and compare) is off. */
export function publicSiteKey(env: Env): string | null {
  const key = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (!key || key === "REPLACE_ME") return null;
  return key;
}
