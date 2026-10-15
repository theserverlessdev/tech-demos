export const LIMITS = {
  maxUrlLength: 2000,
  /**
   * One page step is allowed 120s. Inside it: navigation 12s, a DoH lookup 4s,
   * two network-idle waits of 3s, a screenshot at the page timeout (12s), and a
   * PDF of 12s. Those awaits sum to under the step timeout.
   */
  navigationTimeoutMs: 12_000,
  networkIdleMs: 3_000,
  /** Content-Length cap, in bytes. */
  maxHtmlBytes: 1_500_000,
  /** documentElement.outerHTML.length cap. This counts UTF-16 code units, not bytes. */
  maxHtmlChars: 1_500_000,
  maxScreenshotBytes: 6_000_000,
  maxPdfBytes: 8_000_000,
  maxMarkdownChars: 40_000,
  maxShotHeight: 4096,
  desktopWidth: 1280,
  desktopHeight: 800,
  phoneWidth: 390,
  phoneHeight: 844,
  /** Inactivity window for a browser nobody else is using. Browser Rendering caps this at 10 minutes. */
  keepAliveMs: 300_000,
  /** Overflow browser. Short, then disconnect(). Never close() a browser other steps may be connected to. */
  overflowKeepAliveMs: 10_000,
  /** Contexts reported by Target.getBrowserContexts. At the cap the step tries the next session. */
  maxContexts: 3,
  maxRedirectHops: 4,
  /**
   * Soft cap. A further distinct subresource host is aborted with no DNS lookup.
   * The capture continues. It is not a hard failure.
   */
  maxSubresourceHosts: 64,
  capturesPerHour: 6,
  /** Secondary cap for the IPv6 /48 (or the whole IPv4 address). */
  network48PerHour: 20,
  dailyCap: 300,
  retentionMs: 24 * 60 * 60 * 1000,
  summaryInputChars: 6_000,
  summaryMaxTokens: 220,
} as const;

export const STEP_NAMES = ["Check the URL", "Desktop, PDF, and markdown", "Phone screenshot", "Summary"] as const;

export type StepName = (typeof STEP_NAMES)[number];
