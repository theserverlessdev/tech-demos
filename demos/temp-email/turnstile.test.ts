import { expect, test } from "bun:test";
import { isDummyTurnstileSecret, verifyTurnstile } from "./src/worker/turnstile";

const DUMMY = "1x0000000000000000000000000000000AA";
const REAL = "0x".padEnd(35, "a");
const previousFetch = globalThis.fetch;

function env(hosted: boolean, secret = DUMMY): Env {
  return {
    HOSTED_MODE: hosted ? "true" : "false",
    TURNSTILE_SECRET_KEY: secret,
    PUBLIC_ORIGIN: hosted ? "https://email.lomvic.com" : "http://127.0.0.1:8797",
  } as unknown as Env;
}

function siteverify(body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

test("Cloudflare dummy secrets are detected", () => {
  expect(isDummyTurnstileSecret(DUMMY)).toBe(true);
  expect(isDummyTurnstileSecret(REAL)).toBe(false);
});

test("hosted mode fails closed when the dummy secret is set", async () => {
  try {
    siteverify({ success: true, hostname: "example.com", action: "mint-key" });
    expect(await verifyTurnstile(env(true, DUMMY), "XXXX.DUMMY.TOKEN.XXXX", "203.0.113.9")).toBe(false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("self-host still accepts the dummy secret on localhost", async () => {
  try {
    siteverify({ success: true, hostname: "localhost", action: "mint-key" });
    expect(await verifyTurnstile(env(false, DUMMY), "XXXX.DUMMY.TOKEN.XXXX", "127.0.0.1")).toBe(true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("hosted mint-key requires the mint-key action", async () => {
  try {
    siteverify({ success: true, hostname: "email.lomvic.com" });
    expect(await verifyTurnstile(env(true, REAL), "token", "203.0.113.9")).toBe(false);
    siteverify({ success: true, hostname: "email.lomvic.com", action: "mint-key" });
    expect(await verifyTurnstile(env(true, REAL), "token", "203.0.113.9")).toBe(true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
