/**
 * Loads the worker in a fresh process and asks /api/config for a 503.
 * The monorepo suite mocks cloudflare:workers for other demos, so this check stays out of that module graph.
 */
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({
  tracing: undefined,
  WorkerEntrypoint: class WorkerEntrypoint {},
  DurableObject: class DurableObject {},
  RpcTarget: class RpcTarget {},
  WorkflowEntrypoint: class WorkflowEntrypoint {},
  exports: {},
}));
mock.module("cloudflare:email", () => ({
  EmailMessage: class EmailMessage {},
}));

const worker = (await import("../src/worker/index.ts")).default;
const response = await worker.fetch(
  new Request("https://x402-pay.tech-demos.theserverless.dev/api/config", {
    headers: { "cf-ray": "9a0b0c0d1e2f3a4b-EWR" },
  }),
  {
    LOCAL_DEV: "1",
    X402_MODE: "mock",
    MOCK_FACILITATOR_ORIGIN: "http://127.0.0.1:8796",
  },
);
const body = (await response.json()) as { paid?: boolean; error?: { code?: string } };
if (response.status !== 503 || body.paid !== false || body.error?.code !== "mock_misconfigured") {
  throw new Error(`expected 503 mock_misconfigured, got ${response.status} ${JSON.stringify(body)}`);
}
console.log("public mock gate ok");
