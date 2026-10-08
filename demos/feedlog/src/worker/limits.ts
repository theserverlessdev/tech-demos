export const MAX_POSTS = 80;
export const VISITOR_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const VISITOR_TTL_SECONDS = VISITOR_TTL_MS / 1000;
export const MIN_TITLE = 4;
export const MAX_TITLE = 120;
export const MIN_BODY = 1;
export const MAX_BODY = 4_000;
export const MAX_NAME = 40;
export const MAX_IMAGE_BYTES = 1_500_000;
export const MAX_JSON_BYTES = 32_000;
export const SIMILAR_MIN_CHARS = 12;
export const EMBED_CHARS = 800;
export const VECTOR_DIMS = 384;
export const GATE_TTL_SECONDS = 600;

export const EMBED_MODEL_ID = "@cf/baai/bge-small-en-v1.5";

/** Loopback only. Cloudflare’s published always-pass test pair. Not a production secret. */
export const LOOPBACK_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
export const LOOPBACK_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
/** Loopback only, when ADMIN_TOKEN is unset. Documented in the README. */
export const LOOPBACK_ADMIN_TOKEN = "dev-feedlog-admin";
