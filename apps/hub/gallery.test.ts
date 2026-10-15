import { expect, test } from "bun:test";
import { GALLERY_UI_SCRIPT, renderGallery, THEME_BOOT_SCRIPT } from "./src/gallery.ts";
import { demos } from "./src/registry.ts";

const html = renderGallery(demos);

test("hero names Cloudflare Workers and the one Dynamic Worker", () => {
  expect(html).toContain("Cloudflare Workers · 1 Dynamic Worker");
});

test("card links use the trailing slash", () => {
  expect(html).toContain('href="/demos/hello-dynamic/"');
  expect(html).not.toContain('href="/demos/hello-dynamic"');
});

test("gallery scripts include menu dismiss on Escape and outside tap", () => {
  expect(GALLERY_UI_SCRIPT).toContain('event.key === "Escape"');
  expect(GALLERY_UI_SCRIPT).toContain("pointerdown");
  expect(html).toContain(THEME_BOOT_SCRIPT);
  expect(html).toContain(GALLERY_UI_SCRIPT);
});

test("narrow header CSS hides the wordmark and keeps one row", () => {
  expect(html).toContain(".logo-word { display: none; }");
  expect(html).toContain("flex-wrap: nowrap");
  expect(html).toContain("#demos { scroll-margin-top:");
  expect(html).toContain("min-height: 44px");
});
