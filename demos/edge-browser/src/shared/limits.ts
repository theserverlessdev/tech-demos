export const LIMITS = {
  maxUrlLength: 2000,
  navigationTimeoutMs: 12_000,
  maxHtmlBytes: 1_500_000,
  maxScreenshotBytes: 6_000_000,
  maxPdfBytes: 8_000_000,
  maxMarkdownChars: 40_000,
  maxShotHeight: 4096,
  desktopWidth: 1280,
  desktopHeight: 800,
  phoneWidth: 390,
  phoneHeight: 844,
  /** Inactivity window passed to puppeteer.launch. Browser Rendering caps this at 10 minutes. */
  keepAliveMs: 300_000,
  /** Contexts reported by Target.getBrowserContexts. At the cap the step launches a browser and closes it. */
  maxContexts: 3,
  maxRedirectHops: 4,
  capturesPerHour: 6,
  dailyCap: 300,
  retentionMs: 24 * 60 * 60 * 1000,
  summaryInputChars: 6_000,
  summaryMaxTokens: 220,
} as const;

export const STEP_NAMES = ["Check the URL", "Desktop, PDF, and markdown", "Phone screenshot", "Summary"] as const;

export type StepName = (typeof STEP_NAMES)[number];
