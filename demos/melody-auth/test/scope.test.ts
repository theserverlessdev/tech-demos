import { expect, test } from "bun:test";
import { filterScopes, filterToAppScopes } from "../src/worker/oidc";

test("filterScopes keeps standard OIDC + api scopes and drops unknown", () => {
  expect(filterScopes("openid email profile")).toBe("openid email profile");
  expect(filterScopes("openid offline_access admin")).toBe("openid offline_access");
  expect(filterScopes("profile email api")).toBe("profile email api");
  expect(filterScopes("")).toBe("");
});

test("filterToAppScopes keeps only the app's own scopes", () => {
  expect(filterToAppScopes("openid profile email", ["openid"])).toBe("openid");
  expect(filterToAppScopes("openid calendar", ["calendar"])).toBe("calendar");
  expect(filterToAppScopes("admin", ["openid"])).toBe("");
});
