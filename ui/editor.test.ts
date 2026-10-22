import { expect, test } from "bun:test";
import { makeEditorState, utf8Length, type EditRange } from "./editor.ts";

test("utf8Length matches TextEncoder", () => {
  for (const s of ["", "abc", "café", "日本語", "a😀b", "\ud83d", "x\ud83dy"]) {
    expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
  }
});

test("edits report byte offsets and byte lengths", async () => {
  const seen: { ranges: EditRange[]; base: number; length: number }[] = [];
  const state = makeEditorState("é😀x", {
    onChange: (ranges, base, length) => seen.push({ ranges, base, length }),
  });
  // Replace "x" (UTF-16 offset 3..4, byte offset 6..7) with "ü".
  state.update({ changes: { from: 3, to: 4, insert: "ü" } });
  await Promise.resolve();
  expect(seen).toEqual([{ ranges: [{ from: 6, to: 7, insert: "ü" }], base: 7, length: 8 }]);
});
