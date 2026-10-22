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
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";

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
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    editKeymap,
    ...indentUnit,
    EditorState.readOnly.of(!!opts.readOnly),

    ...(opts.readOnly ? [EditorState.changeFilter.of(() => false)] : []),
    EditorState.transactionExtender.of((tr) => {
      if (tr.docChanged && opts.onChange) {
        const ranges: EditRange[] = [];
        tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
          ranges.push({ from, to, insert: inserted.toString() });
        });
        const base = tr.startState.doc.length;
        const length = tr.state.doc.length;
        const apply = opts.onChange;
        queueMicrotask(() => apply(ranges, base, length));
      }
      return null;
    }),
  ];
  if (opts.withView) exts.push(...viewExtensions());
  return EditorState.create({ doc, extensions: exts });
}
