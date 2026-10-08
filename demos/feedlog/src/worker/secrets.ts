/** Secrets are set with `wrangler secret put`. They are not bindings, so `wrangler types` does not emit them. */
declare global {
  interface Env {
    TURNSTILE_SECRET?: string;
    ADMIN_TOKEN?: string;
  }
}

export {};
