import { expect, test } from "bun:test";
import { discoveryDocument, filterScopes } from "../src/worker/oidc";
import { scopesCovered, makeUserCode, devicePollStatus, type DeviceRow } from "../src/worker/store";
import { clientAllowsGrant } from "../src/worker/clients";
import type { FullApp } from "../src/worker/store";

test("discovery lists OAuth 2.1 grants and omits implicit/password", () => {
  const doc = discoveryDocument("https://melody-auth.example") as {
    grant_types_supported: string[];
    code_challenge_methods_supported: string[];
    introspection_endpoint: string;
    device_authorization_endpoint: string;
    pushed_authorization_request_endpoint: string;
    registration_endpoint: string;
    revocation_endpoint: string;
    response_modes_supported: string[];
  };
  expect(doc.grant_types_supported).toContain("authorization_code");
  expect(doc.grant_types_supported).toContain("client_credentials");
  expect(doc.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:device_code");
  expect(doc.grant_types_supported).not.toContain("implicit");
  expect(doc.grant_types_supported).not.toContain("password");
  expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
  expect(doc.introspection_endpoint.endsWith("/introspect")).toBeTrue();
  expect(doc.revocation_endpoint.endsWith("/revoke")).toBeTrue();
  expect(doc.device_authorization_endpoint.endsWith("/device_authorization")).toBeTrue();
  expect(doc.registration_endpoint.endsWith("/register")).toBeTrue();
  expect(doc.pushed_authorization_request_endpoint.endsWith("/par")).toBeTrue();
  expect(doc.response_modes_supported).toContain("form_post");
});

test("filterScopes accepts extra app scopes", () => {
  expect(filterScopes("openid calendar", ["calendar"])).toBe("openid calendar");
});

test("scopesCovered requires every requested scope", () => {
  expect(scopesCovered("openid email profile", "openid email")).toBeTrue();
  expect(scopesCovered("openid email", "openid offline_access")).toBeFalse();
});

test("makeUserCode is ABCD-EFGH without ambiguous letters", () => {
  const code = makeUserCode();
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

test("devicePollStatus returns slow_down when polled inside the interval", () => {
  const now = 1_000_000;
  const row: DeviceRow = {
    id: "dev_1",
    device_code_hash: "x",
    user_code: "ABCD-EFGH",
    client_id: "melody-sample",
    scope: "openid",
    audience: null,
    expires_at: now + 60_000,
    interval_sec: 5,
    last_poll_at: now - 1000,
    user_id: null,
    denied_at: null,
  };
  expect(devicePollStatus(row, now)).toBe("slow_down");
  expect(devicePollStatus({ ...row, last_poll_at: now - 6000 }, now)).toBe("pending");
  expect(devicePollStatus({ ...row, user_id: "usr_1" }, now)).toBe("ready");
  expect(devicePollStatus({ ...row, denied_at: now }, now)).toBe("denied");
  expect(devicePollStatus({ ...row, expires_at: now - 1 }, now)).toBe("expired");
  expect(devicePollStatus(null, now)).toBe("missing");
});

test("clientAllowsGrant reads JSON grant_types", () => {
  const app = {
    grant_types: '["authorization_code","refresh_token"]',
  } as FullApp;
  expect(clientAllowsGrant(app, "authorization_code")).toBeTrue();
  expect(clientAllowsGrant(app, "client_credentials")).toBeFalse();
});
