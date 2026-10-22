import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { makeEditorState, type EditRange } from "./editor.ts";
import { panic, parseJson, run } from "./panic.ts";

type RpcFn = (payload: string) => string;
declare global {
  interface Window {
    rpc: RpcFn & { _reply?: (id: number, result: string) => void };
  }
}

let seq = 0;
const inflight = new Map<number, { resolve: (value: unknown) => void }>();

window.rpc._reply = (id, result) => {
  const entry = inflight.get(id);
  if (!entry) return;
  inflight.delete(id);
  entry.resolve(parseJson(result));
};

function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve) => {
    inflight.set(id, { resolve: (value) => resolve(value as T) });
    window.rpc(JSON.stringify({ id, method, params }));
  });
}

interface DocSummary {
  id: string;
  name: string;
  state: string;
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) panic(`missing element ${selector}`);
  return found;
}

const tabsEl = element<HTMLDivElement>("#tabs");
const editorEl = element<HTMLDivElement>("#editor");
const statusEl = element<HTMLSpanElement>("#status");
const emptyEl = element<HTMLDivElement>("#empty");
const newButton = element<HTMLButtonElement>("#new-doc");
const revealButton = element<HTMLButtonElement>("#reveal");

newButton.addEventListener("click", () => run(newDocument));
revealButton.addEventListener("click", () => run(rpc, "reveal"));

let view: EditorView | null = null;
let activeId: string | null = null;
let docs: DocSummary[] = [];

const editState = new Map<string, { pending: EditRange[]; length: number; inFlight: boolean }>();

function queueEdit(id: string, ranges: EditRange[], length: number) {
  const entry = editState.get(id) ?? { pending: [], length, inFlight: false };
  entry.pending.push(...ranges);
  entry.length = length;
  editState.set(id, entry);
  if (entry.inFlight) return;
  entry.inFlight = true;

  run(async () => {
    while (entry.pending.length > 0) {
      const batch = entry.pending;
      entry.pending = [];
      await rpc("edit", { id, ranges: batch, length: entry.length });
    }
    entry.inFlight = false;
  });
}

function statusText(): string {
  const parts = ["idle"];
  if (docs.length) parts[0] = `${docs.length} open`;
  return parts.join(" · ");
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...docs.map((d) => {
      const tab = document.createElement("div");
      tab.className = "tab" + (d.id === activeId ? " active" : "");
      const dot = document.createElement("span");
      dot.className = `dot ${d.state}`;
      const label = document.createElement("span");
      label.textContent = d.name;
      const close = document.createElement("span");
      close.className = "close";
      close.textContent = "×";
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        run(closeDoc, d.id);
      });
      tab.append(dot, label, close);
      tab.addEventListener("click", () => run(activate, d.id));
      return tab;
    }),
  );
  statusEl.textContent = statusText();
}

async function activate(id: string) {
  const doc = await rpc<{ text: string }>("open", { id });
  activeId = id;
  emptyEl.remove();

  const state = makeEditorState(doc.text, {
    withView: true,
    onChange: (ranges, length) => {
      queueEdit(id, ranges, length);
    },
  });

  if (view) {
    view.setState(state);
  } else {
    view = new EditorView({
      state,
      parent: editorEl,
      extensions: [syntaxHighlighting(defaultHighlightStyle, { fallback: true })],
    });
  }
  view.focus();
  renderTabs();
}

async function closeDoc(id: string) {
  await rpc("close", { id });
  if (activeId === id) {
    activeId = null;
    view?.destroy();
    view = null;
    editorEl.append(emptyEl);
  }
  await refresh();
}

async function refresh() {
  docs = await rpc<DocSummary[]>("list");
  if (!activeId && docs.length) await activate(docs[0]!.id);
  if (docs.length === 0) showEmpty();
  renderTabs();
}

async function newDocument() {
  const doc = await rpc<{ id: string }>("create", { name: "untitled.txt" });
  await refresh();
  await activate(doc.id);
}

function showEmpty() {
  emptyEl.replaceChildren("No documents. ");
  const button = document.createElement("button");
  button.textContent = "New document";
  button.addEventListener("click", () => run(newDocument));
  emptyEl.append(button);
  if (!emptyEl.isConnected) editorEl.append(emptyEl);
}

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "s") {
    e.preventDefault();
    if (activeId) run(async () => { await rpc("save", { id: activeId }); await refresh(); });
  }
  if (mod && e.key === "w") {
    e.preventDefault();
    if (activeId) run(closeDoc, activeId);
  }
  if (mod && e.key === "n") {
    e.preventDefault();
    run(newDocument);
  }
});

setInterval(() => run(refresh), 2000);

run(refresh);
