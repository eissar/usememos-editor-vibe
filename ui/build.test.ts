import { expect, test } from "bun:test";

test("ui_html.h is pure ascii", async () => {
  const header = await Bun.file(new URL("../native/ui_html.h", import.meta.url)).text();
  const bad = header.replace(/[\x20-\x7e\n]/g, "");
  expect(bad).toBe("");
});
