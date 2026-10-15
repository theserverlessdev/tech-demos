export function orgTtlMs(env: Env): number {
  return orgTtlHours(env) * 60 * 60 * 1000;
}

export function orgTtlSeconds(env: Env): number {
  return orgTtlHours(env) * 60 * 60;
}

export function orgTtlHours(env: Env): number {
  const hours = Number(env.ORG_TTL_HOURS);
  return Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : 24;
}
