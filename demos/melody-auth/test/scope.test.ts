import { expect, test } from "bun:test";
import { filterScopes } from "../src/worker/oidc";

test("filterScopes keeps only openid profile email", () => {
  expect(filterScopes("openid email profile")).toBe("openid email profile");
  expect(filterScopes("openid offline_access admin")).toBe("openid");
  expect(filterScopes("profile email")).toBe("profile email");
  expect(filterScopes("")).toBe("");
});
