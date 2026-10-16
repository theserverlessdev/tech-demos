import { expect, test } from "bun:test";
import { emailShape, hashPassword, maskEmail, normalizeEmail, passwordShape, verifyPassword } from "../src/worker/password";

test("PBKDF2 hash verifies with the same salt", async () => {
  const first = await hashPassword("correct-horse");
  expect(await verifyPassword("correct-horse", first.hash, first.salt)).toBeTrue();
  expect(await verifyPassword("wrong-horse", first.hash, first.salt)).toBeFalse();
});

test("a second hash uses a different salt", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  expect(a.salt).not.toBe(b.salt);
  expect(a.hash).not.toBe(b.hash);
  expect(await verifyPassword("same-password", b.hash, b.salt)).toBeTrue();
});

test("email is normalized and shaped", () => {
  expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  expect(emailShape("ada@example.com")).toBeTrue();
  expect(emailShape("not-an-email")).toBeFalse();
  expect(passwordShape("1234567")).toBeFalse();
  expect(passwordShape("12345678")).toBeTrue();
});

test("maskEmail keeps only the last domain label", () => {
  expect(maskEmail("alice@example.com")).toBe("a***@***.com");
  expect(maskEmail("b@x.io")).toBe("b***@***.io");
  expect(maskEmail("ada@mail.example.co.uk")).toBe("a***@***.uk");
  expect(maskEmail("broken")).toBe("***");
});
