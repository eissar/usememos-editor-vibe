import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { makeEditorState, type EditRange } from "./editor.ts";
import { assert, describe, panic, parseReplyObject, run } from "./panic.ts";

/*
 * The host replies by evaluating window.rpc._reply(id, json) in this document,
 * and rpc() matches that against the id it sent. The promise window.rpc()
 * itself returns resolves to null and is ignored.
 */
type RpcFn = (payload: Record<string, unknown>) => unknown;
declare global {
  interface Window {
    rpc: RpcFn & { _reply?: (id: number, result: string) => void };
  }
}

let seq = 0;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

const inflight = new Map<number, Pending>();

window.rpc._reply = (id, result) => {
  const entry = inflight.get(id);
  if (entry === undefined) return;
  inflight.delete(id);

  const parsed = parseReplyObject(result);
  if (!parsed.ok) {
    entry.reject(new Error("rpc: malformed reply"));
    return;
  }
  const body = parsed.value;
  if (body["error"] !== undefined) {
    entry.reject(new Error(`rpc: ${String(body["error"])}`));
    return;
  }
  entry.resolve(body["value"]);
};

const RPC_TIMEOUT_MS = 3000;

let rpcQueue: Promise<unknown> = Promise.resolve();

function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const call = rpcQueue.then(() => callWithTimeout<T>(method, params));
  rpcQueue = call.then(
    () => undefined,
    () => undefined,
  );
  return call;
}

function callWithTimeout<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const id = ++seq;

  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      inflight.delete(id);
      return true;
    };

    const timer = setTimeout(() => {
      if (finish()) reject(new Error(`rpc ${method}: no reply within ${RPC_TIMEOUT_MS}ms`));
    }, RPC_TIMEOUT_MS);

    inflight.set(id, {
      resolve: (value) => {
        if (finish()) resolve(value as T);
      },
      reject,
    });

    try {
      // Pass the object itself: webview serialises the argument array into `req`,
      // so a pre-stringified payload arrives double-encoded and unparseable.
      window.rpc({ id, method, params });
    } catch (error) {
      if (finish()) reject(new Error(describe(error)));
    }
  });
}

function isDocText(value: unknown): value is { text: string } {
  return typeof (value as { text?: unknown } | null)?.text === "string";
}

function isDocId(value: unknown): value is { id: string } {
  return typeof (value as { id?: unknown } | null)?.id === "string";
}

interface DocSummary {
  id: string;
  name: string;
  state: string;
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  assert(found !== null, `missing element ${selector}`);
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

/*
 * Edits are held per document and written after IDLE_MS without typing. Each
 * transaction stays its own batch: a batch's ranges all address the document
 * as it was before that transaction, so two transactions cannot share one.
 */
const IDLE_MS = 3000;

interface Batch {
  ranges: EditRange[];
  baseLength: number;
  length: number;
}

interface EditQueue {
  batches: Batch[];
  timer: ReturnType<typeof setTimeout> | null;
  writing: Promise<void> | null;
}

const editState = new Map<string, EditQueue>();

function isDirty(id: string): boolean {
  const q = editState.get(id);
  return q !== undefined && (q.batches.length > 0 || q.writing !== null);
}

function queueEdit(id: string, ranges: EditRange[], baseLength: number, length: number) {
  let q = editState.get(id);
  if (q === undefined) {
    q = { batches: [], timer: null, writing: null };
    editState.set(id, q);
  }
  const wasDirty = isDirty(id);
  q.batches.push({ ranges, baseLength, length });
  if (q.timer !== null) clearTimeout(q.timer);
  q.timer = setTimeout(() => run(flushEdits, id), IDLE_MS);
  if (!wasDirty) renderTabs();
}

/* Writes every held edit for `id` now and resolves once the host has them. */
async function flushEdits(id: string): Promise<void> {
  const q = editState.get(id);
  if (q === undefined) return;
  if (q.timer !== null) {
    clearTimeout(q.timer);
    q.timer = null;
  }
  while (q.writing !== null) await q.writing;
  if (q.batches.length === 0) return;

  q.writing = (async () => {
    try {
      while (q.batches.length > 0) {
        const batch = q.batches[0]!;
        await rpc("edit", { id, ...batch });
        q.batches.shift();
      }
    } finally {
      q.writing = null;
    }
  })();
  await q.writing;
  renderTabs();
}

function statusText(): string {
  const parts = ["idle"];
  if (docs.length) parts[0] = `${docs.length} open`;
  return parts.join(" · ");
}

/* Set while a tab label is being edited, so the periodic refresh does not
 * re-render the strip out from under the cursor. */
let renaming = false;

async function renameDoc(id: string, name: string) {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === id) {
    renderTabs();
    return;
  }
  await flushEdits(id);
  try {
    const reply = await rpc<unknown>("rename", { id, name: trimmed });
    assert(isDocId(reply), "rename: reply has no id");
    editState.delete(id);
    if (activeId === id) {
      activeId = null;
      await activate(reply.id);
    }
  } catch (error) {
    // A rejected name is the user's input, not a broken program: report it in
    // the status bar instead of halting.
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("rpc: ")) throw error;
    renderTabs();
    statusEl.textContent = message.slice(5);
    return;
  }
  await refresh();
}

function beginRename(label: HTMLElement, id: string) {
  renaming = true;
  label.contentEditable = "true";
  label.spellcheck = false;
  label.focus();
  getSelection()?.selectAllChildren(label);

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    label.contentEditable = "false";
    renaming = false;
    const name = label.textContent ?? "";
    if (commit) run(renameDoc, id, name);
    else renderTabs();
  };
  label.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  label.addEventListener("blur", () => finish(true), { once: true });
}

function renderTabs() {
  if (renaming) return;
  tabsEl.replaceChildren(
    ...docs.map((d) => {
      const tab = document.createElement("div");
      tab.className = "tab" + (d.id === activeId ? " active" : "");
      const dot = document.createElement("span");
      dot.className = `dot ${d.state}`;
      const label = document.createElement("span");
      label.textContent = d.name || d.id;
      label.className = "label";
      label.title = "Double-click to rename";
      label.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        beginRename(label, d.id);
      });
      const close = document.createElement("span");
      close.className = "close";
      close.textContent = "×";
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        run(closeDoc, d.id);
      });
      const unsaved = document.createElement("span");
      unsaved.className = "unsaved";
      unsaved.textContent = isDirty(d.id) ? "*" : "";
      tab.append(dot, label, unsaved, close);
      tab.addEventListener("click", () => run(activate, d.id));
      return tab;
    }),
  );
  statusEl.textContent = statusText();
}

async function activate(id: string) {
  if (activeId !== null) await flushEdits(activeId);
  await flushEdits(id);
  const reply = await rpc<unknown>("open", { id });
  assert(isDocText(reply), "open: reply has no text");
  activeId = id;
  emptyEl.remove();

  const state = makeEditorState(reply.text, {
    withView: true,
    onChange: (ranges, baseLength, length) => {
      queueEdit(id, ranges, baseLength, length);
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
  await flushEdits(id);
  editState.delete(id);
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
  const listed = await rpc<unknown>("list");
  assert(Array.isArray(listed), "list: reply is not an array");
  docs = listed as DocSummary[];
  if (!activeId && docs.length) await activate(docs[0]!.id);
  if (docs.length === 0) showEmpty();
  renderTabs();
}

async function newDocument() {
  const reply = await rpc<unknown>("create", { name: "untitled" });
  assert(isDocId(reply), "create: reply has no id");
  await refresh();
  await activate(reply.id);
}

function showEmpty() {
  emptyEl.replaceChildren("No documents. ");
  const button = document.createElement("button");
  button.textContent = "New document";
  button.addEventListener("click", () => run(newDocument));
  emptyEl.append(button);
  if (!emptyEl.isConnected) editorEl.append(emptyEl);
}

function cycleTab(step: number) {
  if (docs.length === 0) return;
  const at = docs.findIndex((d) => d.id === activeId);
  const next = docs[(at + step + docs.length) % docs.length]!;
  run(activate, next.id);
}

async function saveActive() {
  if (!activeId) return;
  const id = activeId;
  statusEl.textContent = "saving…";
  await flushEdits(id);
  await rpc("save", { id });
  await refresh();
  statusEl.textContent = "saved";
}

/*
 * Capture phase on window so nothing inside the page (CodeMirror included) can
 * swallow the chord first. e.code identifies the physical key, so Caps Lock,
 * Shift and non-US layouts do not change which shortcut fires.
 */
window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey) return;

    let handled = true;
    switch (e.code) {
      case "KeyS":
        run(saveActive);
        break;
      case "KeyW":
        if (activeId) run(closeDoc, activeId);
        break;
      case "KeyN":
        run(newDocument);
        break;
      case "Tab":
        cycleTab(e.shiftKey ? -1 : 1);
        break;
      case "PageDown":
        cycleTab(1);
        break;
      case "PageUp":
        cycleTab(-1);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  { capture: true },
);

setInterval(() => run(refresh), 2000);

run(refresh);
