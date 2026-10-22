import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
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

export function viewExtensions(): Extension[] {
  return [
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
    onChange?: (ranges: EditRange[], length: number) => void;
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
        const length = tr.state.doc.length;
        queueMicrotask(() => opts.onChange!(ranges, length));
      }
      return null;
    }),
  ];
  if (opts.withView) exts.push(...viewExtensions());
  return EditorState.create({ doc, extensions: exts });
}
