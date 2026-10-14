import { SOCKET_RATE, SOCKET_WINDOW_MS } from "../shared/types";

export type TokenBucket = {
  tokens: number;
  tokensAt: number;
  strikes: number;
};

export function newBucket(now = Date.now()): TokenBucket {
  return { tokens: SOCKET_RATE, tokensAt: now, strikes: 0 };
}

/** 5 tokens per 10 seconds, stored on the socket attachment. */
export function takeToken(bucket: TokenBucket, now = Date.now(), rate = SOCKET_RATE, windowMs = SOCKET_WINDOW_MS): boolean {
  const step = windowMs / rate;
  const refill = Math.floor((now - bucket.tokensAt) / step);
  if (refill > 0) {
    bucket.tokens = Math.min(rate, bucket.tokens + refill);
    bucket.tokensAt += refill * step;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
