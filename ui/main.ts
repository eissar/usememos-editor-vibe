import { EditorView } from "@codemirror/view";
import { makeEditorState, type EditRange } from "./editor.ts";
import { assert, describe, installGlobalHandlers, panic, parseReplyObject, run } from "./panic.ts";
import { MemoBrowser } from "./browser.ts";
import { MemosClient, describeError } from "./usememos_api.ts";

installGlobalHandlers();

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
  title: string;
  synced: boolean;
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  assert(found !== null, `missing element ${selector}`);
  return found;
}

const tabsEl = element<HTMLDivElement>("#tabs");
const editorEl = element<HTMLDivElement>("#editor");
const statusEl = element<HTMLSpanElement>("#status");
// The footer cuts long messages short; the full text is the hover title.
new MutationObserver(() => {
  statusEl.title = statusEl.textContent ?? "";
}).observe(statusEl, { childList: true, characterData: true, subtree: true });
const emptyEl = element<HTMLDivElement>("#empty");
const browseButton = element<HTMLButtonElement>("#browse");
const revealButton = element<HTMLButtonElement>("#reveal");

/* The Memos client is built on first use from the host's environment. */
let memosClient: Promise<MemosClient> | null = null;

function getMemosClient(): Promise<MemosClient> {
  memosClient ??= rpc<{ baseUrl?: unknown; token?: unknown; apiPrefix?: unknown }>("config").then((c) => {
    assert(typeof c.baseUrl === "string" && typeof c.token === "string", "config: missing baseUrl or token");
    return new MemosClient({
      baseUrl: c.baseUrl,
      token: c.token,
      apiPrefix: typeof c.apiPrefix === "string" ? c.apiPrefix : undefined,
    });
  });
  return memosClient;
}

/*
 * Opens a cloud memo for editing: fetch it, hand it to the host as
 * memos/<memo id>.md, show it. Resolves to an error message, or null.
 */
async function openMemo(id: string): Promise<string | null> {
  const client = await getMemosClient();
  const memo = await client.getMemo(id);
  if (!memo.ok) return describeError(memo.error);
  if (memo.value.updateTime === undefined) return "the server did not return an updateTime";
  try {
    await rpc("import", { id, content: memo.value.content, updateTime: memo.value.updateTime });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("rpc: ")) throw error;
    return message.slice(5);
  }
  await refresh();
  await activate(id);
  return null;
}

const browser = new MemoBrowser(element<HTMLElement>("#browser"), getMemosClient, openMemo);
browseButton.addEventListener("click", () => run(() => browser.open()));
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
  /* Fires once the save is late; only re-renders so the mark can turn red. */
  lateTimer: ReturnType<typeof setTimeout> | null;
  /* When the held edits should be on disk. */
  deadline: number;
}

/* Grace after the deadline before an unsaved mark counts as late. */
const LATE_MS = 500;

const editState = new Map<string, EditQueue>();

function isDirty(id: string): boolean {
  const q = editState.get(id);
  return q !== undefined && (q.batches.length > 0 || q.writing !== null);
}

function isLate(id: string): boolean {
  const q = editState.get(id);
  return q !== undefined && isDirty(id) && Date.now() >= q.deadline + LATE_MS;
}

function queueEdit(id: string, ranges: EditRange[], baseLength: number, length: number) {
  let q = editState.get(id);
  if (q === undefined) {
    q = { batches: [], timer: null, writing: null, lateTimer: null, deadline: 0 };
    editState.set(id, q);
  }
  const wasDirty = isDirty(id);
  q.batches.push({ ranges, baseLength, length });
  if (q.timer !== null) clearTimeout(q.timer);
  q.timer = setTimeout(() => run(flushEdits, id), IDLE_MS);
  q.deadline = Date.now() + IDLE_MS;
  if (q.lateTimer !== null) clearTimeout(q.lateTimer);
  q.lateTimer = setTimeout(() => {
    if (isLate(id)) renderTabs();
  }, IDLE_MS + LATE_MS);
  if (!wasDirty || isLate(id)) renderTabs();
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
  scheduleSync(id);
  // The label is the first line, so it can change with any save.
  await refresh();
}

/*
 * Cloud sync. A push is attempted SYNC_MS after a document's last save; until
 * it succeeds the tab shows ^ (waiting) and then ! (failed). Either state
 * blocks closing, because closing deletes the local file.
 */
const SYNC_MS = 10_000;

const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
/* Why the last push of a document failed. */
const syncFailed = new Map<string, string>();

function scheduleSync(id: string) {
  const pending = syncTimers.get(id);
  if (pending !== undefined) clearTimeout(pending);
  syncFailed.delete(id);
  syncTimers.set(
    id,
    setTimeout(() => run(attemptSync, id), SYNC_MS),
  );
}

function forgetSync(id: string) {
  const pending = syncTimers.get(id);
  if (pending !== undefined) clearTimeout(pending);
  syncTimers.delete(id);
  syncFailed.delete(id);
}

interface SyncBegin {
  synced: boolean;
  version: string;
  cloudTime: string;
  text: string;
}

function isSyncBegin(v: unknown): v is SyncBegin {
  const b = v as Partial<SyncBegin> | null;
  return (
    typeof b?.synced === "boolean" &&
    typeof b.version === "string" &&
    typeof b.cloudTime === "string" &&
    typeof b.text === "string"
  );
}

/*
 * Pushes one document to its memo. Refuses to overwrite a memo changed in the
 * cloud since this copy was pulled or last pushed (updateTime differs).
 */
async function attemptSync(id: string) {
  syncTimers.delete(id);
  // An edit still held will save, and saving reschedules the push.
  if (isDirty(id)) return;
  const failure = await pushMemo(id);
  if (failure === null) syncFailed.delete(id);
  else syncFailed.set(id, failure);
  await refresh();
}

/* Resolves to null on success (or nothing to push), else the reason. */
async function pushMemo(id: string): Promise<string | null> {
  const begin = await rpc<unknown>("sync_begin", { id });
  assert(isSyncBegin(begin), "sync_begin: malformed reply");
  if (begin.synced) return null;
  if (begin.cloudTime === "") return "not linked to a cloud memo";

  const client = await getMemosClient();
  const current = await client.getMemo(id);
  if (!current.ok) return describeError(current.error);
  if (current.value.updateTime !== begin.cloudTime) {
    return "the memo changed in the cloud since it was opened; not overwriting";
  }

  const pushed = await client.updateContent(id, begin.text);
  if (!pushed.ok) return describeError(pushed.error);
  if (pushed.value.updateTime === undefined) return "the server did not return an updateTime";

  await rpc("sync_done", { id, version: begin.version, updateTime: pushed.value.updateTime });
  return null;
}

function syncMark(d: DocSummary): { text: string; title: string; failed: boolean } {
  if (d.synced) return { text: "", title: "", failed: false };
  const failure = syncFailed.get(d.id);
  if (failure !== undefined) return { text: "!", title: `Cloud sync failed: ${failure}`, failed: true };
  return { text: "^", title: "Waiting to sync to the cloud", failed: false };
}

/* Runs `fn`; an rpc error (the host refusing a request) goes to the status bar
 * instead of halting. */
async function reportRefusal(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("rpc: ")) throw error;
    renderTabs();
    statusEl.textContent = message.slice(5);
  }
}

function statusText(): string {
  const parts = ["idle"];
  if (docs.length) parts[0] = `${docs.length} open`;
  return parts.join(" | ");
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...docs.map((d) => {
      const tab = document.createElement("div");
      tab.className = "tab" + (d.id === activeId ? " active" : "");
      const label = document.createElement("span");
      label.textContent = d.title || "(empty)";
      label.className = "label" + (d.title ? "" : " untitled");
      const close = document.createElement("span");
      close.className = "close";
      close.textContent = "x";
      if (!d.synced) {
        close.classList.add("blocked");
        close.title = "Not synced to the cloud; cannot close";
      } else {
        close.title = "Close and delete the local file";
      }
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        run(closeDoc, d.id);
      });
      const mark = syncMark(d);
      // Fixed two-cell slot, always present, so a tab never changes width
      // when a mark appears or clears.
      const marks = document.createElement("span");
      marks.className = "marks";
      const sync = document.createElement("span");
      sync.className = "sync" + (mark.failed ? " failed" : "");
      sync.textContent = mark.text || " ";
      sync.title = mark.title;
      const unsaved = document.createElement("span");
      const late = isLate(d.id);
      unsaved.className = "unsaved" + (late ? " late" : "");
      unsaved.textContent = isDirty(d.id) ? "*" : " ";
      unsaved.title = !isDirty(d.id) ? "" : late ? "Save is late" : "Unsaved";
      marks.append(unsaved, sync);
      tab.append(label, marks, close);
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
    });
  }
  view.focus();
  renderTabs();
}

/* Closing deletes the local file. The host refuses while the document has
 * changes the cloud does not. */
async function closeDoc(id: string) {
  await flushEdits(id);
  await reportRefusal(async () => {
    await rpc("close", { id });
    editState.delete(id);
    forgetSync(id);
    if (activeId === id) {
      activeId = null;
      view?.destroy();
      view = null;
      editorEl.append(emptyEl);
    }
    await refresh();
  });
}

async function refresh() {
  const listed = await rpc<unknown>("list");
  assert(Array.isArray(listed), "list: reply is not an array");
  docs = listed as DocSummary[];
  for (const d of docs) {
    if (!d.synced && !syncTimers.has(d.id) && !syncFailed.has(d.id)) scheduleSync(d.id);
  }
  if (!activeId && docs.length) await activate(docs[0]!.id);
  if (docs.length === 0) showEmpty();
  renderTabs();
}

function showEmpty() {
  emptyEl.replaceChildren("No documents.");
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
  statusEl.textContent = "saving...";
  await flushEdits(id);
  await rpc("save", { id });

  // Ctrl+S also pushes now instead of waiting out the sync debounce.
  const pending = syncTimers.get(id);
  if (pending !== undefined) clearTimeout(pending);
  statusEl.textContent = "syncing...";
  await attemptSync(id);
  const failure = syncFailed.get(id);
  statusEl.textContent = failure === undefined ? "saved and synced" : `saved; sync failed: ${failure}`;
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

/*
 * No polling: memos/ is re-read when the window regains focus, which is when
 * changes made elsewhere first matter. Held edits are written when focus
 * leaves, so a rescan never meets unsaved text.
 */
async function flushAll() {
  await Promise.all([...editState.keys()].map((id) => flushEdits(id)));
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

async function rescan() {
  await flushAll();
  const reply = await rpc<{ changed?: unknown; removed?: unknown }>("rescan");
  assert(isIdList(reply.changed) && isIdList(reply.removed), "rescan: malformed reply");
  for (const id of reply.removed) {
    editState.delete(id);
    forgetSync(id);
  }
  for (const id of reply.changed) scheduleSync(id);
  // Coming back is also when a failed push (network, server) may now work.
  for (const id of [...syncFailed.keys()]) scheduleSync(id);

  if (activeId !== null && reply.removed.includes(activeId)) {
    activeId = null;
    view?.destroy();
    view = null;
    editorEl.append(emptyEl);
  } else if (activeId !== null && reply.changed.includes(activeId)) {
    await activate(activeId);
  }
  await refresh();
}

window.addEventListener("blur", () => run(flushAll));
window.addEventListener("focus", () => run(rescan));

/* The host's startup watchdog fails loudly unless this arrives. */
run(async () => {
  await refresh();
  await rpc("ready");
});
