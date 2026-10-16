import { expect, test } from "bun:test";
import { filterScopes } from "../src/worker/oidc";

test("filterScopes keeps standard OIDC + api scopes and drops unknown", () => {
  expect(filterScopes("openid email profile")).toBe("openid email profile");
  expect(filterScopes("openid offline_access admin")).toBe("openid offline_access");
  expect(filterScopes("profile email api")).toBe("profile email api");
  expect(filterScopes("")).toBe("");
});
