import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { TEST_PRIVATE_JWK, TEST_PUBLIC_JWK } from "./test/jwk";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            ENVIRONMENT: "test",
            POLICY_AUD: "agent-mail-test-aud",
            WEBHOOK_KEY: "test-webhook-key",
            ACCESS_TEST_JWK: JSON.stringify({ keys: [TEST_PUBLIC_JWK] }),
            ACCESS_TEST_PRIVATE_JWK: JSON.stringify(TEST_PRIVATE_JWK),
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
