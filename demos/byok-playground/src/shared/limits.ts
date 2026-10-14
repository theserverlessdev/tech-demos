export const LIMITS = {
  requestBytes: 32_768,
  responseBytes: 524_288,
  errorBytes: 16_384,
  probeBytes: 32_768,
  sseBytes: 262_144,
  sseCarryBytes: 65_536,
  timeoutMs: 20_000,
  idleTimeoutMs: 30_000,
  overallTimeoutMs: 120_000,
  capabilityTotalMs: 60_000,
  capabilityProbeMs: 15_000,
  sessionTtlMs: 12 * 60 * 60 * 1000,
  maxMessages: 15,
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

/** Legacy header name. The key is sent in the JSON body; this is still stripped if present. */
export const KEY_HEADER = "x-byok-key";
export const SESSION_COOKIE = "byok_session";
export const CANONICAL_HOST = "byok-playground.tech-demos.theserverless.dev";
export const HUB_BASE_PATH = "/demos/byok-playground";
