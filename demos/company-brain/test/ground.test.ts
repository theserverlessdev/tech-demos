import { expect, test } from "bun:test";
import { isDontKnow, settleAnswer, type MemoryRow } from "../src/worker/ground";

const warehouse: MemoryRow = {
  kind: "fact",
  id: "f_aaaabbbb",
  text: "Northline ships weekly on Thursdays from the Austin warehouse.",
  author: "Ops",
  source: "seed",
};

const refund: MemoryRow = {
  kind: "decision",
  id: "d_55555555",
  text: "Refunds over $200 need a second approver before they are issued.",
  author: "Finance",
  source: "refund policy",
};

const hits = [warehouse, refund];

test("invented uncited answer is ungrounded with no sources", () => {
  const settled = settleAnswer("The warehouse ships every Monday at 6am.", hits);
  expect(settled.answer).toBe("I don't know.");
  expect(settled.sources).toEqual([]);
  expect(settled.grounded).toBeFalse();
});

test("forged citation id is stripped and the real row is not attached", () => {
  const settled = settleAnswer("Refunds need three approvers [decision:d_deadbeef].", hits);
  expect(settled.answer).toBe("I don't know.");
  expect(settled.sources).toEqual([]);
  expect(settled.grounded).toBeFalse();
});

test("I don't know followed by extra text is a refusal", () => {
  const settled = settleAnswer("I don't know. The warehouse items do not include a wifi password.", hits);
  expect(settled.answer).toBe("I don't know.");
  expect(settled.sources).toEqual([]);
  expect(settled.grounded).toBeFalse();
});

test("memory-does-not-mention answer without a citation is ungrounded", () => {
  const settled = settleAnswer("The memory items do not mention the warehouse wifi password.", hits);
  expect(settled.answer).toBe("I don't know.");
  expect(settled.sources).toEqual([]);
  expect(settled.grounded).toBeFalse();
});

test("a matching citation keeps the answer and only that source", () => {
  const settled = settleAnswer(
    `Northline ships weekly on Thursdays from the Austin warehouse. [fact:${warehouse.id}]`,
    hits,
  );
  expect(settled.grounded).toBeTrue();
  expect(settled.answer).toContain("[fact:f_aaaabbbb]");
  expect(settled.sources).toHaveLength(1);
  expect(settled.sources[0]?.id).toBe(warehouse.id);
});

test("uppercase citation ids match the lowercase stored row", () => {
  const settled = settleAnswer("Refunds over $200 need a second approver. [DECISION:D_55555555]", hits);
  expect(settled.grounded).toBeTrue();
  expect(settled.answer).toContain("[decision:d_55555555]");
  expect(settled.sources[0]?.id).toBe(refund.id);
});

test("isDontKnow treats prefix refusals, not only an exact sentence", () => {
  expect(isDontKnow("I don't know.")).toBeTrue();
  expect(isDontKnow("I dont know")).toBeTrue();
  expect(isDontKnow("I do not know whether that is stored.")).toBeTrue();
  expect(isDontKnow("I don't know. The warehouse items do not include a wifi password.")).toBeTrue();
  expect(isDontKnow("The warehouse ships on Thursday.")).toBeFalse();
});
