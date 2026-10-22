import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { makeEditorState, type EditRange } from "./editor.ts";
import { assert, panic, parseReplyObject, run } from "./panic.ts";

/* The host binds `rpc` with webview_bind, so calling it returns the reply
 * directly through webview_return. There is no separate reply channel and no
 * correlation id: a promise that never settles is the only failure mode if the
 * two sides disagree, which is exactly how the buttons ended up inert. */
type RpcFn = (payload: string) => Promise<string> | string;
declare global {
  interface Window {
    rpc: RpcFn;
  }
}

const RPC_TIMEOUT_MS = 3000;

/* One call in flight at a time. The host answers a bound call synchronously
 * through webview_return, so overlapping calls depend on that ordering holding
 * for every method; serialising removes the question entirely. */
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
  return new Promise<T>((resolve, reject) => {
    // The host's bound function cannot be cancelled, so the timer only rejects
    // the caller's promise. The queue is freed by rpc() swallowing the
    // rejection, which keeps a hung call from stranding every later one.
    let done = false;
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      return true;
    };

    const timer = setTimeout(() => {
      if (finish()) reject(new Error(`rpc ${method}: no reply within ${RPC_TIMEOUT_MS}ms`));
    }, RPC_TIMEOUT_MS);

    Promise.resolve(window.rpc(JSON.stringify({ method, params })))
      .then((reply) => {
        if (!finish()) return;
        const parsed = parseReplyObject(reply);
        assert(parsed.ok, `rpc ${method}: malformed reply`);
        const body = parsed.value;
        assert(body["error"] === undefined, `rpc ${method}: ${String(body["error"])}`);
        resolve(body["value"] as T);
      })
      .catch((error: unknown) => {
        if (!finish()) return;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
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

const editState = new Map<string, EditBatch>();

interface EditBatch {
  pending: EditRange[];
  baseLength: number;
  length: number;
  inFlight: boolean;
}

function queueEdit(id: string, ranges: EditRange[], baseLength: number, length: number) {
  const entry: EditBatch = editState.get(id) ?? { pending: [], baseLength, length, inFlight: false };
  entry.pending.push(...ranges);
  entry.baseLength = baseLength;
  entry.length = length;
  editState.set(id, entry);
  if (entry.inFlight) return;
  entry.inFlight = true;

  run(async () => {
    try {
      while (entry.pending.length > 0) {
        const batch = entry.pending;
        entry.pending = [];
        await rpc("edit", {
          id,
          ranges: batch,
          baseLength: entry.baseLength,
          length: entry.length,
        });
      }
    } finally {
      entry.inFlight = false;
    }
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
  const reply = await rpc<unknown>("create", { name: "untitled.txt" });
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
