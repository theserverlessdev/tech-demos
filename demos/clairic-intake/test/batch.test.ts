import { expect, test } from "bun:test";
import { LIMITS } from "../src/shared/limits";
import { PRESETS } from "../src/shared/presets";
import { INVOICE_STATE, SUPPORT_STATE } from "../src/shared/samples";
import { decisionState } from "../src/shared/policy";
import worker from "../src/worker/index";
import { enqueueBundledInbox, handleQueueMessage, LEASE_RETRY_DELAY_SECONDS, MAX_QUEUE_ATTEMPTS, processInboxItem, publicInbox } from "../src/worker/batch";
import { getInbox, listInbox, reserveCalls, reviewInbox, spendUsed } from "../src/worker/db";
import { mockClairic, mockCompare } from "../src/worker/mock";
import { asD1, memoryDb } from "./helpers";

function env() {
  const db = memoryDb();
  const sent: { body: { id: string } }[][] = [];
  return {
    db,
    sent,
    env: {
      ENVIRONMENT: "local",
      DB: asD1(db),
      INTAKE: {
        send: async () => {},
        sendBatch: async (messages: { body: { id: string } }[]) => {
          sent.push(messages);
        },
      },
    } as unknown as Env,
  };
}

test("mock extraction of the invoice is typed, spanned, and honest about the missing PO", () => {
  const result = mockClairic(INVOICE_STATE, PRESETS.invoice.fields, false);
  expect(result.answers.invoice_number.value).toBe("INV-2291");
  expect(result.answers.invoice_number.span).toEqual([8, 16]);
  expect(result.answers.total.value).toBe(1080);
  expect(result.answers.due_date.value).toBe("2026-10-02");
  expect(result.answers.po_number.value).toBeNull();
  expect(result.answers.contacts.value).toEqual(["Dana Ruiz", "Priya Shah"]);
  expect(result.answers.days_to_pay.median).toBe(30);
  expect(result.review.some((flag) => flag.field === "po_number")).toBe(true);
  const comparison = mockCompare(INVOICE_STATE, PRESETS.invoice.fields);
  expect(comparison?.schemaValid).toBe(false);
});

test("the support email computes the paid total and the days since delivery", () => {
  const result = mockClairic(SUPPORT_STATE, PRESETS.support.fields, false);
  expect(result.answers.order_id.value).toBe("A-88412");
  expect(result.answers.amount_paid.value).toBe(701.1);
  expect(result.answers.days_since_delivery.value).toBe(11);
  expect(result.answers.damage.value).toEqual(["cracked screen", "dented corner"]);
  expect(result.answers.tracking_number.value).toBeNull();
  const state = decisionState(result.answers);
  expect(state.startsWith("Policy:")).toBe(true);
  expect(state.includes(SUPPORT_STATE)).toBe(false);
  expect(state).toContain("order_id: A-88412");
});

test("the batch pipeline lands the inbox in review and a correction sticks", async () => {
  const { env: worker, sent } = env();
  const now = Date.parse("2026-10-22T15:00:00Z");
  const ids = await enqueueBundledInbox(worker, "visitor", "ip", now);
  expect(ids).toHaveLength(12);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveLength(12);
  const rows = await listInbox(worker, "visitor");
  expect(rows.every((row) => row.status === "review")).toBe(true);
  const invoice = rows.find((row) => row.sample_id === "in-01");
  expect(invoice).toBeTruthy();
  const answers = JSON.parse(invoice?.answers_json ?? "{}") as { invoice_number: { value: string } };
  expect(answers.invoice_number.value).toBe("INV-2291");

  const again = await handleQueueMessage(worker, { id: ids[0] }, 1, now);
  expect(again).toEqual({ action: "ack" });
  expect((await getInbox(worker, ids[0]))?.status).toBe("review");
  const published = publicInbox(invoice!);
  expect(published.state).toContain("INV-2291");
  expect("stateText" in published).toBe(false);

  expect(await handleQueueMessage(worker, { id: "nope" }, 1, now)).toEqual({ action: "ack" });
  const saved = await reviewInbox(worker, invoice!.id, "visitor", JSON.stringify({ vendor: "Northwind Supply" }), now);
  expect(saved).toBe(true);
  expect((await getInbox(worker, invoice!.id))?.status).toBe("accepted");
  expect((await getInbox(worker, invoice!.id))?.corrections_json).toContain("Northwind Supply");
});

test("a bad schema fails closed and a thrown extract is retried then failed", async () => {
  const { env: worker } = env();
  const now = Date.parse("2026-10-22T15:00:00Z");
  const ids = await enqueueBundledInbox(worker, "visitor", "ip", now);
  await worker.DB.prepare("UPDATE inbox SET status = 'queued', fields_json = ? WHERE id = ?").bind("{}", ids[0]).run();
  expect(await processInboxItem(worker, ids[0], now)).toBe("done");
  expect((await getInbox(worker, ids[0]))?.status).toBe("failed");

  await worker.DB.prepare("UPDATE inbox SET status = 'queued', fields_json = ? WHERE id = ?").bind("{", ids[1]).run();
  expect(await handleQueueMessage(worker, { id: ids[1] }, 1, now)).toEqual({ action: "retry" });
  expect((await getInbox(worker, ids[1]))?.status).toBe("queued");
  expect(await handleQueueMessage(worker, { id: ids[1] }, MAX_QUEUE_ATTEMPTS - 1, now)).toEqual({ action: "retry" });
  expect(await handleQueueMessage(worker, { id: ids[1] }, MAX_QUEUE_ATTEMPTS, now)).toEqual({ action: "ack" });
  expect((await getInbox(worker, ids[1]))?.status).toBe("failed");
  expect((await getInbox(worker, ids[1]))?.error).toBe("extract_failed");
});

test("a live lease is retried and an expired lease is claimed again", async () => {
  const { env: worker } = env();
  const now = Date.parse("2026-10-22T15:00:00Z");
  const ids = await enqueueBundledInbox(worker, "visitor", "ip", now);
  await worker.DB.prepare("UPDATE inbox SET status = 'running', updated_at = ? WHERE id = ?").bind(now, ids[0]).run();
  expect(await processInboxItem(worker, ids[0], now + 1_000)).toBe("lease");
  expect(await handleQueueMessage(worker, { id: ids[0] }, 1, now + 1_000)).toEqual({
    action: "retry",
    delaySeconds: LEASE_RETRY_DELAY_SECONDS,
  });
  expect(LEASE_RETRY_DELAY_SECONDS * 1000).toBeGreaterThan(LIMITS.leaseMs);
  expect((await getInbox(worker, ids[0]))?.status).toBe("running");
  expect(await handleQueueMessage(worker, { id: ids[0] }, MAX_QUEUE_ATTEMPTS, now + 2_000)).toEqual({ action: "ack" });
  expect((await getInbox(worker, ids[0]))?.status).toBe("failed");
  expect((await getInbox(worker, ids[0]))?.error).toBe("extract_failed");

  await worker.DB.prepare("UPDATE inbox SET status = 'running', updated_at = ? WHERE id = ?").bind(now, ids[1]).run();
  const redelivery = now + LEASE_RETRY_DELAY_SECONDS * 1000;
  expect(await handleQueueMessage(worker, { id: ids[1] }, 2, redelivery)).toEqual({ action: "ack" });
  expect((await getInbox(worker, ids[1]))?.status).toBe("review");
  expect(await spendUsed(worker.DB, "ip", redelivery)).toBe(1);
  expect(await handleQueueMessage(worker, { id: ids[1] }, 3, redelivery + 1_000)).toEqual({ action: "ack" });
  expect(await spendUsed(worker.DB, "ip", redelivery)).toBe(1);
});

test("a failed queue send marks the rows failed and refunds both spend rows", async () => {
  const db = memoryDb();
  const now = Date.parse("2026-10-22T15:00:00Z");
  const worker = {
    ENVIRONMENT: "",
    DB: asD1(db),
    INTAKE: {
      send: async () => {},
      sendBatch: async () => {
        throw new Error("queue down");
      },
    },
  } as unknown as Env;
  expect(await reserveCalls(worker.DB, "ip", now, 12)).toBe("ok");
  await expect(enqueueBundledInbox(worker, "visitor", "ip", now)).rejects.toThrow("queue down");
  const rows = await listInbox(worker, "visitor");
  expect(rows).toHaveLength(12);
  expect(rows.every((row) => row.status === "failed" && row.error === "queue_send_failed")).toBe(true);
  expect(await spendUsed(worker.DB, "ip", now)).toBe(0);
  expect(await spendUsed(worker.DB, "*", now)).toBe(0);
});

function queueMessage(body: unknown, attempts: number) {
  const message = {
    id: "msg",
    timestamp: new Date(),
    body,
    attempts,
    acked: false,
    retried: null as { delaySeconds?: number } | null,
    ack() {
      message.acked = true;
    },
    retry(options?: { delaySeconds?: number }) {
      message.retried = options ?? {};
    },
  };
  return message;
}

test("the queue handler delays a live lease and fails the last attempt", async () => {
  const { env: workerEnv } = env();
  const now = Date.now();
  const ids = await enqueueBundledInbox(workerEnv, "visitor", "ip", now);
  await workerEnv.DB.prepare("UPDATE inbox SET status = 'running', updated_at = ? WHERE id = ?").bind(now, ids[0]).run();
  const live = queueMessage({ id: ids[0] }, 1);
  await worker.queue({ queue: "tech-demos-clairic-intake", messages: [live] } as unknown as MessageBatch, workerEnv);
  expect(live.acked).toBe(false);
  expect(live.retried).toEqual({ delaySeconds: 65 });
  expect((await getInbox(workerEnv, ids[0]))?.status).toBe("running");

  const last = queueMessage({ id: ids[0] }, 4);
  await worker.queue({ queue: "tech-demos-clairic-intake", messages: [last] } as unknown as MessageBatch, workerEnv);
  expect(last.acked).toBe(true);
  expect(last.retried).toBeNull();
  expect((await getInbox(workerEnv, ids[0]))?.status).toBe("failed");
  expect((await getInbox(workerEnv, ids[0]))?.error).toBe("extract_failed");
});

test("the queue handler retries when the last attempt cannot mark the row failed", async () => {
  const { env: workerEnv } = env();
  const now = Date.now();
  const ids = await enqueueBundledInbox(workerEnv, "visitor", "ip", now);
  await workerEnv.DB.prepare("UPDATE inbox SET status = 'running', updated_at = ? WHERE id = ?").bind(now, ids[0]).run();
  const realPrepare = workerEnv.DB.prepare.bind(workerEnv.DB);
  workerEnv.DB.prepare = ((sql: string) => {
    if (sql.includes("status = 'failed'")) throw new Error("d1 down");
    return realPrepare(sql);
  }) as typeof workerEnv.DB.prepare;
  const message = queueMessage({ id: ids[0] }, 4);
  await worker.queue({ queue: "tech-demos-clairic-intake", messages: [message] } as unknown as MessageBatch, workerEnv);
  expect(message.acked).toBe(false);
  expect(message.retried).toEqual({});
  expect((await getInbox(workerEnv, ids[0]))?.status).toBe("running");
});

test("a retry that cannot reserve another call fails closed", async () => {
  const { env: worker } = env();
  const now = Date.parse("2026-10-22T15:00:00Z");
  const ids = await enqueueBundledInbox(worker, "visitor", "ip", now);
  const { reserveCalls } = await import("../src/worker/db");
  expect(await reserveCalls(worker.DB, "ip", now, 40)).toBe("ok");
  await worker.DB.prepare("UPDATE inbox SET status = 'queued', answers_json = NULL WHERE id = ?").bind(ids[2]).run();
  expect(await processInboxItem(worker, ids[2], now, 2)).toBe("done");
  expect((await getInbox(worker, ids[2]))?.status).toBe("failed");
  expect((await getInbox(worker, ids[2]))?.error).toBe("budget");
});
