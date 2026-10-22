import { describe, expect, test } from "bun:test";
import { PRESETS } from "../src/shared/presets";
import { imageIsRemote, llmSchemaReport, parseCorrections, parseModelJson, validateFields, validateImage, validateState } from "../src/shared/schema";
import { INBOX } from "../src/shared/samples";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("field schema", () => {
  test("the three presets are valid Clairic schemas", () => {
    for (const preset of Object.values(PRESETS)) {
      const parsed = validateFields(preset.fields);
      expect(parsed.ok).toBe(true);
    }
  });

  test("rejects an empty schema, a bad name, a list without items, and an estimate without bounds", () => {
    expect(validateFields({}).ok).toBe(false);
    expect(validateFields({ "1bad": { type: "text" } }).ok).toBe(false);
    expect(validateFields(JSON.parse('{"__proto__":{"type":"text"}}')).ok).toBe(false);
    const list = validateFields({ damage: { type: "list" } });
    expect(list.ok).toBe(false);
    const estimate = validateFields({ cost: { type: "estimate", min: 10 } });
    expect(estimate.ok).toBe(false);
    const decimals = validateFields({ total: { type: "number", decimals: 7 } });
    expect(decimals.ok).toBe(false);
    const horizon = validateFields({ next: { type: "forecast", min: 0, max: 10, horizon: 0, interval: "day" } });
    expect(horizon.ok).toBe(false);
    const tooFar = validateFields({ next: { type: "forecast", min: 0, max: 10, horizon: 64, interval: "day" } });
    expect(tooFar.ok).toBe(false);
  });

  test("accepts a duration in days and rejects a remote image", () => {
    const parsed = validateFields({ wait: { type: "duration", unit: "days", integer: true, decimals: 0 } });
    expect(parsed.ok).toBe(true);
    expect(imageIsRemote("https://example.com/a.png")).toBe(true);
    expect(validateImage("https://example.com/a.png").ok).toBe(false);
    expect(validateImage({ url: "https://example.com/a.png", content_type: "image/png", base64: "aaaa" }).ok).toBe(false);
    const image = validateImage({ content_type: "image/png", base64: btoa(String.fromCharCode(...png)) });
    expect(image.ok).toBe(true);
    expect(validateImage({ content_type: "image/jpeg", base64: btoa(String.fromCharCode(...png)) }).ok).toBe(false);
  });

  test("LLM output must match the field types", () => {
    const fields = PRESETS.invoice.fields;
    const bad = llmSchemaReport(fields, parseModelJson('```json\n{"total":"$10","issued":"Sept 2"}\n```'));
    expect(bad.valid).toBe(false);
    expect(bad.reasons.some((reason) => reason.includes("total"))).toBe(true);
    const good = llmSchemaReport(
      { total: fields.total, issued: fields.issued },
      { total: 10, issued: "2026-09-02" },
    );
    expect(good.valid).toBe(true);
  });

  test("state and corrections stay bounded", () => {
    expect(validateState("", false).ok).toBe(false);
    expect(validateState("hello", false).ok).toBe(true);
    expect(validateState("x".repeat(12_001), true).ok).toBe(false);
    const fields = { vendor: PRESETS.invoice.fields.vendor };
    expect(parseCorrections(fields, { vendor: "Northwind" }).ok).toBe(true);
    expect(parseCorrections(fields, { other: "x" }).ok).toBe(false);
    expect(parseCorrections(fields, { vendor: "<script>" }).ok).toBe(true);
  });

  test("the bundled inbox is 12 documents and has no fetch URL field", () => {
    expect(INBOX).toHaveLength(12);
    for (const doc of INBOX) {
      expect("url" in doc).toBe(false);
      expect(doc.state.length).toBeGreaterThan(20);
      expect(PRESETS[doc.preset]).toBeTruthy();
    }
  });
});
