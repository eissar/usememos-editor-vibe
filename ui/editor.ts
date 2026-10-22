import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";

/*
 * Memos are Markdown (GFM). Fenced code blocks are highlighted in their own
 * language, looked up by the fence's info string (```ts, ```python, ...).
 */
const markdownSupport = markdown({ base: markdownLanguage, codeLanguages: languages });

/* Token colours for the dark palette; covers Markdown and code alike. */
const darkHighlight = HighlightStyle.define([
  // One size for every line: headings differ by colour and weight only, so
  // line height never varies.
  { tag: t.heading, color: "#e5c07b", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700", color: "#e6e9ef" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "#7b8494" },
  { tag: [t.link, t.url], color: "#6ea8fe", textDecoration: "underline" },
  { tag: t.quote, color: "#98a2b3", fontStyle: "italic" },
  { tag: t.monospace, color: "#98c379" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "#5c6370" },

  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#c678dd" },
  { tag: [t.definitionKeyword, t.modifier], color: "#c678dd" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "#98c379" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "#d19a66" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "#5c6370", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#61afef" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#e06c75" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "#e5c07b" },
  { tag: [t.propertyName, t.attributeName], color: "#e06c75" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: "#abb2bf" },
  { tag: [t.self, t.special(t.variableName)], color: "#e06c75", fontStyle: "italic" },
  { tag: t.invalid, color: "#ff5555" },
]);

/* The palette from index.html; CodeMirror's defaults are light. */
const darkTheme = EditorView.theme(
  {
    "&": { backgroundColor: "#16181d", color: "#d6dae3" },
    ".cm-content": { caretColor: "#6ea8fe" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#6ea8fe" },
    ".cm-gutters": { backgroundColor: "#16181d", color: "#4b5260", border: "none", borderRight: "1px solid #2a2e38" },
    ".cm-activeLineGutter": { backgroundColor: "#1d2027", color: "#7b8494" },
    ".cm-activeLine": { backgroundColor: "#1d202780" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#2b3a55" },
    ".cm-selectionMatch": { backgroundColor: "#2b3a5580" },
    ".cm-foldPlaceholder": { backgroundColor: "#262a33", border: "none", color: "#7b8494" },
    ".cm-panels": { backgroundColor: "#1d2027", color: "#d6dae3" },
    ".cm-tooltip": { backgroundColor: "#1d2027", border: "1px solid #2a2e38" },
  },
  { dark: true },
);

export function viewExtensions(): Extension[] {
  return [
    darkTheme,
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    foldGutter(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    highlightSelectionMatches(),
    search({ top: true }),
  ];
}

export const editKeymap: Extension = keymap.of([
  ...closeBracketsKeymap,
  ...defaultKeymap,
  ...searchKeymap,
  ...historyKeymap,
  ...foldKeymap,
  ...completionKeymap,
  ...lintKeymap,
  indentWithTab,
]);

export const indentUnit = [EditorState.tabSize.of(2)];

/* Byte length of `s` encoded as UTF-8, without encoding it. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/* Offsets and lengths are UTF-8 bytes. */
export interface EditRange {
  from: number;
  to: number;
  insert: string;
}

export function makeEditorState(
  doc: string,
  opts: {
    onChange?: (ranges: EditRange[], baseLength: number, length: number) => void;
    readOnly?: boolean;
    withView?: boolean;
  } = {},
): EditorState {
  const exts: Extension[] = [
    history(),
    indentOnInput(),
    markdownSupport,
    syntaxHighlighting(darkHighlight),
    editKeymap,
    ...indentUnit,
    EditorState.readOnly.of(!!opts.readOnly),

    ...(opts.readOnly ? [EditorState.changeFilter.of(() => false)] : []),
    EditorState.transactionExtender.of((tr) => {
      if (tr.docChanged && opts.onChange) {
        // The host stores UTF-8 and splices bytes, while CodeMirror counts
        // UTF-16 units, so every offset and length is converted to bytes.
        const before = tr.startState.doc;
        const ranges: EditRange[] = [];
        tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
          const fromByte = utf8Length(before.sliceString(0, from));
          const toByte = fromByte + utf8Length(before.sliceString(from, to));
          ranges.push({ from: fromByte, to: toByte, insert: inserted.toString() });
        });
        const base = utf8Length(before.toString());
        const length = utf8Length(tr.state.doc.toString());
        const apply = opts.onChange;
        queueMicrotask(() => apply(ranges, base, length));
      }
      return null;
    }),
  ];
  if (opts.withView) exts.push(...viewExtensions());
  return EditorState.create({ doc, extensions: exts });
}
