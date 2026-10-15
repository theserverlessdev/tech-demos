import { describe, expect, test } from "bun:test";
import { SEED_TICKETS, isSeedTicket } from "../src/worker/db";
import { cookiePath } from "../src/worker/session";
import { R2_DELETE_LIMIT, chunkKeys } from "../src/worker/sweep";

describe("seed lock and visitor scope", () => {
  test("the five public tickets are locked seeds", () => {
    expect(SEED_TICKETS.map((t) => t.id)).toEqual(["tkt_billing", "tkt_sso", "tkt_cron", "tkt_webhooks", "tkt_docs"]);
    for (const seed of SEED_TICKETS) {
      expect(isSeedTicket(seed.id)).toBe(true);
      expect(seed.updatedAt).toBeGreaterThan(1_780_000_000_000);
    }
    expect(isSeedTicket("tkt_visitor_made")).toBe(false);
  });

  test("hub origin scopes the session cookie away from other demos", () => {
    expect(cookiePath(new Request("https://tech-demos.theserverless.dev/demos/resolve-hq/api/tickets"))).toBe("/demos/resolve-hq");
    expect(cookiePath(new Request("http://127.0.0.1:8787/api/tickets"))).toBe("/");
  });

  test("R2 deletes are split into groups of 1000", () => {
    const keys = Array.from({ length: 2_501 }, (_, i) => `tickets/v/k${i}`);
    const chunks = chunkKeys(keys);
    expect(R2_DELETE_LIMIT).toBe(1000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(1000);
    expect(chunks[1]).toHaveLength(1000);
    expect(chunks[2]).toHaveLength(501);
    expect(chunkKeys([...keys, "seed/inv-8841-duplicate.txt"]).flat()).not.toContain("seed/inv-8841-duplicate.txt");
    expect(chunkKeys([])).toEqual([]);
  });
});
