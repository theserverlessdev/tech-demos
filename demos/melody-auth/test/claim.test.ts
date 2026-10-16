import { expect, test } from "bun:test";
import { claimCode, claimRefresh } from "../src/worker/db";

type Step = { changes?: number; row?: unknown };

function mockDb(script: Step[]): D1Database {
  const next = () => script.shift() ?? {};
  const stmt = {
    bind() {
      return stmt;
    },
    async run() {
      return { success: true, meta: { changes: next().changes ?? 0 } };
    },
    async first() {
      return next().row ?? null;
    },
  };
  return { prepare: () => stmt } as unknown as D1Database;
}

const row = {
  id: "code_1",
  code_hash: "x",
  user_id: "usr_1",
  client_id: "melody-sample",
  redirect_uri: "http://127.0.0.1:8788/",
  code_challenge: "c",
  nonce: "n",
  scope: "openid",
  expires_at: Date.now() + 60_000,
  used_at: Date.now(),
};

test("claimCode requires meta.changes === 1", async () => {
  const won = await claimCode(mockDb([{ changes: 1 }, { row }]), "fresh-code", Date.now());
  expect(won?.id).toBe("code_1");

  const lost = await claimCode(mockDb([{ changes: 0 }, { row }, { changes: 1 }]), "fresh-code", Date.now());
  expect(lost).toBeNull();
});

test("claimRefresh revokes the family when the claim loses", async () => {
  const refresh = {
    id: "rt_1",
    token_hash: "x",
    family_id: "fam_1",
    user_id: "usr_1",
    client_id: "melody-sample",
    scope: "openid",
    expires_at: Date.now() + 60_000,
    revoked_at: Date.now(),
    replaced_by: null,
  };
  const lost = await claimRefresh(mockDb([{ row: refresh }, { changes: 0 }, { changes: 2 }]), "old-refresh", Date.now());
  expect(lost).toBeNull();
});
