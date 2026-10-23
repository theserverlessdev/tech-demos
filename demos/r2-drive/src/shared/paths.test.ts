import { expect, test } from "bun:test";
import { confinePath, destinationKey, splitDavPath } from "./paths";

const id = "drv_0123456789abcdef0123456789abcdef";

test("path confinement rejects traversal and encoded separators", () => {
  expect(confinePath("/notes/a.txt")).toBe("notes/a.txt");
  expect(confinePath("/../secret")).toBeNull();
  expect(confinePath("/%2e%2e/secret")).toBeNull();
  expect(confinePath("/%2fetc")).toBeNull();
  expect(confinePath("/%5cwindows")).toBeNull();
  expect(splitDavPath(`/dav/${id}/%2e%2e/x`)).toBe("bad");
  expect(splitDavPath(`/demos/r2-drive/dav/${id}/ok.txt`)).toMatchObject({ key: "ok.txt" });
});

test("Destination stays on the same mount", () => {
  const request = `http://127.0.0.1:8808/dav/${id}/a.txt`;
  const mount = `/dav/${id}`;
  expect(destinationKey(`${new URL(request).origin}${mount}/b.txt`, request, mount)).toBe("b.txt");
  expect(destinationKey("https://evil.example/dav/x", request, mount)).toBeNull();
  expect(destinationKey(`http://user:pass@127.0.0.1:8808${mount}/b.txt`, request, mount)).toBeNull();
  expect(destinationKey(`http://127.0.0.1:8808/dav/drv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/b.txt`, request, mount)).toBeNull();
  expect(destinationKey(`http://127.0.0.1:8808${mount}/../../etc/passwd`, request, mount)).toBeNull();
});
