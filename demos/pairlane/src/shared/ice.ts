import { STUN_URL, type IceServer } from "./protocol";

const TURN_URL = /^(turns?|stuns?):[^\s?]+/i;

export type TurnEnv = {
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
};

/** URLs that look like STUN or TURN. Query strings are kept for ICE and stripped for CSP. */
export function turnUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const url = part.trim();
    if (TURN_URL.test(url)) out.push(url);
  }
  return out;
}

export function iceServersFromEnv(env: TurnEnv): { servers: IceServer[]; turn: boolean } {
  const servers: IceServer[] = [{ urls: STUN_URL }];
  const urls = turnUrls(env.TURN_URLS);
  const username = env.TURN_USERNAME?.trim() ?? "";
  const credential = env.TURN_CREDENTIAL?.trim() ?? "";
  if (urls.length > 0 && username && credential) {
    servers.push({ urls: urls.length === 1 ? urls[0]! : urls, username, credential });
    return { servers, turn: true };
  }
  return { servers, turn: false };
}

/** CSP connect-src. Scheme sources keep STUN and optional TURN from being dropped as invalid hosts. */
export function connectSources(turnRaw: string | undefined): string[] {
  const sources = ["'self'", "https://challenges.cloudflare.com", "stun:", "stuns:", "turn:", "turns:"];
  for (const url of turnUrls(turnRaw)) {
    const bare = url.split("?")[0] ?? url;
    if (!sources.includes(bare)) sources.push(bare);
  }
  return sources;
}
