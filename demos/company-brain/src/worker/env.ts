// Secrets stay out of generated bindings. `typecheck` passes an empty env file so a local
// .dev.vars does not turn this into a required string. Fail closed when either is unset.
declare global {
  interface Env {
    TURNSTILE_SECRET?: string;
    ORG_ID_KEY?: string;
  }
}

export {};
