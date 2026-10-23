import { expect, test } from "bun:test";
import { isDisposableEmail, normalizeEmail } from "./email-address";

test("normalise strips plus tags and gmail dots", () => {
  expect(normalizeEmail(" Ada.Lovelace+demo@Gmail.com ")).toBe("adalovelace@gmail.com");
  expect(normalizeEmail("ada.lovelace@googlemail.com")).toBe("adalovelace@gmail.com");
  expect(normalizeEmail("Ada.Lovelace+x@Example.com")).toBe("ada.lovelace@example.com");
  expect(normalizeEmail("not an email")).toBeNull();
});

test("disposable domains match the domain and its parents", () => {
  expect(isDisposableEmail("person@mailinator.com")).toBe(true);
  expect(isDisposableEmail("person@example.com")).toBe(false);
  expect(isDisposableEmail("x@a.mailinator.com")).toBe(true);
  expect(isDisposableEmail("x@email.lomvic.com")).toBe(true);
  expect(isDisposableEmail("x@gmail.com")).toBe(false);
});
