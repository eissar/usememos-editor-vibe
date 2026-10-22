import { expect, test } from "bun:test";

const header = await Bun.file(new URL("../native/ui_html.h", import.meta.url)).text();

test("ui_html.h is pure ascii", () => {
  const bad = header.replace(/[\x20-\x7e\n]/g, "");
  expect(bad).toBe("");
});

test("page has exactly one script pair and no nested tags", () => {
  const opens = header.match(/<script/g) ?? [];
  const closes = header.match(/<\/script/g) ?? [];
  expect(opens.length).toBe(1);
  expect(closes.length).toBe(1);
});

test("inlined script contains no replacement-pattern leaks", () => {
  expect(header).not.toContain('src=\\"./main.ts\\"');
});
