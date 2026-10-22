import { expect, test } from "bun:test";
import { PRESETS } from "../src/shared/presets";
import { INVOICE_STATE, SUPPORT_STATE } from "../src/shared/samples";
import { decisionState } from "../src/shared/policy";
import { enqueueBundledInbox, handleQueueMessage, processInboxItem } from "../src/worker/batch";
import { getInbox, listInbox, reviewInbox } from "../src/worker/db";
import { mockClairic, mockCompare } from "../src/worker/mock";
import { asD1, memoryDb } from "./helpers";

function env() {
  const db = memoryDb();
  return {
    db,
    env: {
      ENVIRONMENT: "local",
      DB: asD1(db),
      INTAKE: { send: async () => {} },
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
  expect(state.includes(SUPPORT_STATE)).toBe(false);
  expect(state).toContain("order_id: A-88412");
});

test("the batch pipeline lands the inbox in review and a correction sticks", async () => {
  const { env: worker } = env();
  const now = Date.parse("2026-10-22T15:00:00Z");
  const ids = await enqueueBundledInbox(worker, "visitor", "ip", now);
  expect(ids).toHaveLength(12);
  const rows = await listInbox(worker, "visitor");
  expect(rows.every((row) => row.status === "review")).toBe(true);
  const invoice = rows.find((row) => row.sample_id === "in-01");
  expect(invoice).toBeTruthy();
  const answers = JSON.parse(invoice?.answers_json ?? "{}") as { invoice_number: { value: string } };
  expect(answers.invoice_number.value).toBe("INV-2291");

  const again = await handleQueueMessage(worker, { id: ids[0] }, 1, now);
  expect(again).toBe("ack");
  expect((await getInbox(worker, ids[0]))?.status).toBe("review");

  expect(await handleQueueMessage(worker, { id: "nope" }, 1, now)).toBe("ack");
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
  expect(await handleQueueMessage(worker, { id: ids[1] }, 1, now)).toBe("retry");
  expect((await getInbox(worker, ids[1]))?.status).toBe("queued");
  expect(await handleQueueMessage(worker, { id: ids[1] }, 3, now)).toBe("ack");
  expect((await getInbox(worker, ids[1]))?.status).toBe("failed");
});
