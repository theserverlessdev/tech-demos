import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/worker/errors";
import { fileResponseHeaders, safeFilename, sniffUpload } from "../src/worker/files";

describe("upload allowlist", () => {
  test("accepts plain text and rejects javascript", () => {
    expect(sniffUpload("text/plain", new TextEncoder().encode("hello"))).toBe("text/plain");
    expect(() => sniffUpload("text/javascript", new TextEncoder().encode("alert(1)"))).toThrow(HttpError);
    expect(() => sniffUpload("text/html", new TextEncoder().encode("<script>"))).toThrow(HttpError);
  });

  test("download headers never execute and always attach", () => {
    const headers = fileResponseHeaders({ content_type: "text/javascript", filename: 'evil".js', size: 4 });
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("content-disposition")).toContain("attachment");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-security-policy")).toContain("sandbox");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  test("filenames are sanitized", () => {
    expect(safeFilename("../../x.js")).toBe("__.._x.js");
    expect(safeFilename("inv-8841-duplicate.txt")).toBe("inv-8841-duplicate.txt");
  });
});
