import { expect, test } from "bun:test";
import { mintOrgId, orgIdShape, orgIdValid } from "../src/worker/org-id";

const KEY = "test-org-id-key";

test("minted ids keep the org_ + 32 hex shape and verify", async () => {
  const id = await mintOrgId(KEY);
  expect(orgIdShape(id)).toBeTrue();
  expect(await orgIdValid(KEY, id)).toBeTrue();
});

test("a random 32-hex id is rejected before any Durable Object is named", async () => {
  const forged = `org_${"ab".repeat(16)}`;
  expect(orgIdShape(forged)).toBeTrue();
  expect(await orgIdValid(KEY, forged)).toBeFalse();
});

test("a tag from another key does not verify", async () => {
  const id = await mintOrgId(KEY);
  expect(await orgIdValid("other-key", id)).toBeFalse();
});

test("mutating one tag nibble fails", async () => {
  const id = await mintOrgId(KEY);
  const flipped = `${id.slice(0, -1)}${id.endsWith("0") ? "1" : "0"}`;
  expect(orgIdShape(flipped)).toBeTrue();
  expect(await orgIdValid(KEY, flipped)).toBeFalse();
});

test("missing key never verifies", async () => {
  const id = await mintOrgId(KEY);
  expect(await orgIdValid("", id)).toBeFalse();
});
