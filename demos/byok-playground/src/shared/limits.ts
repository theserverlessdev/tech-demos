export const LIMITS = {
  requestBytes: 32_768,
  responseBytes: 524_288,
  timeoutMs: 20_000,
  concurrentGlobal: 8,
  concurrentPerIp: 2,
  maxMessages: 16,
  maxMessageChars: 4_000,
  maxSystemChars: 2_000,
  maxModelChars: 128,
  maxBaseUrlChars: 500,
  maxKeyChars: 8_192,
  maxTokensMin: 16,
  maxTokensMax: 1_024,
  maxTokensDefault: 256,
  compareMaxTokens: 128,
  dailyCompareCap: 200,
  ipCompareCap: 12,
} as const;

export const ALLOWED_SUFFIXES = ["/chat/completions", "/models"] as const;
export type AllowedSuffix = (typeof ALLOWED_SUFFIXES)[number];

export const KEY_HEADER = "x-byok-key";
export const SESSION_COOKIE = "byok_session";
