import { expect, test } from "bun:test";

const header = await Bun.file(new URL("../native/ui_html.h", import.meta.url)).text();

test("ui_html.h is pure ascii", () => {
  const bad = header.replace(/[\x20-\x7e\n]/g, "");
  expect(bad).toBe("");
});

test("the html carries no script; the bundle is a separate literal", () => {
  const html = header.slice(header.indexOf("UI_HTML ="), header.indexOf("UI_JS ="));
  expect(html).not.toContain("<script");
  expect(html).toContain('data-app=\\"text-edit\\"');
  expect(header).toContain("static const char *UI_JS =");
});

test("the html stays far below WebView2's 2 MB NavigateToString limit", () => {
  const html = header.slice(header.indexOf("UI_HTML ="), header.indexOf("UI_JS ="));
  // UTF-16 doubles it; leave a wide margin.
  expect(html.length * 2).toBeLessThan(512 * 1024);
});

test("inlined script contains no replacement-pattern leaks", () => {
  expect(header).not.toContain('src=\\"./main.ts\\"');
});

test("ui_html.h contains no trigraphs", () => {
  expect(header).not.toMatch(/\?\?[=/'()!<>\-]/);
});
