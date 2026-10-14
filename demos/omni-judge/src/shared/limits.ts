export const LIMITS = {
  maxQuestions: 5,
  minOptions: 2,
  maxOptions: 6,
  minQuestionChars: 8,
  maxQuestionChars: 160,
  minOptionChars: 1,
  maxOptionChars: 48,
  maxImageBytes: 2 * 1024 * 1024,
  /** Width times height, read from the image header. */
  maxImagePixels: 16_000_000,
  maxAudioBytes: Math.floor(1.5 * 1024 * 1024),
  maxAudioMs: 15_000,
  maxVideoBytes: 6 * 1024 * 1024,
  maxVideoMs: 10_000,
  /** The page stops near 9.5s. Containers often land a little over 10s. */
  videoSlackMs: 500,
  /** Whole multipart body, a little above the video cap for form fields. */
  maxBodyBytes: 6_500_000,
  perVisitorHour: 8,
  perNetworkHour: 8,
  /** Rolling 24 hours, counted in D1 with the hourly caps. */
  dailyCap: 80,
  retentionMs: 24 * 60 * 60 * 1000,
  historyLimit: 12,
  maxUntrustedChars: 2_000,
} as const;

export const OMNI_MODEL_ID = "@cf/cloudflare/clef-omni";
export const CLEF_MODEL_ID = "@cf/cloudflare/clef";
export const WHISPER_MODEL_ID = "@cf/openai/whisper-large-v3-turbo";
export const VISION_MODEL_ID = "@cf/meta/llama-3.2-11b-vision-instruct";

/** Prices copied from the Workers AI model pages. Output tokens are not billed for Clef models. */
export const PRICES = {
  omniPerMInput: 0.15,
  clefPerMInput: 0.24,
  visionPerMInput: 0.0485,
  visionPerMOutput: 0.676,
  whisperPerMinute: 0.000513,
} as const;
