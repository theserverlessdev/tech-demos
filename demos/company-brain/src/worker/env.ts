// Wrangler secrets are not part of generated bindings. Fail closed when this is unset.
declare global {
  interface Env {
    TURNSTILE_SECRET?: string;
  }
}

export {};
