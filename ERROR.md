# Errors

Every failure observed while running the Windows build, and what it turned out
to be.

---

## `rpc <method>: no reply within 3000ms`

Seen for `create` and for `list`. The window opened, the editor rendered, and a
button produced a 3-second timeout with the stack trace pointing into the
bundle:

```
text-edit: Error: rpc list: no reply within 3000ms
    at about:blank:97:57048
```

### Cause

`webview_bind` callbacks run on the webview's **own callback thread**. That
thread does not own the DOM, so `webview_eval` called from it does not execute —
the document lives on the UI thread. Every reply was therefore discarded, no
promise ever settled, and the only visible symptom was the timeout.

`webview_return` does not help: it answers the *native* caller of the bound
function, a channel the page never observes.

### Fix

Replies are posted to the UI thread with `webview_dispatch`, which is the API for
exactly this:

```c
webview_dispatch(g_window, eval_on_main, job);   /* job->script carries _reply(...) */
```

A non-zero return from `webview_dispatch` is fatal, so a failure to queue is
reported rather than becoming another silent timeout.

### How to tell it is this bug

The timeout is a fixed 3s every time, for every method, on the first call after
the window loads. Not intermittent, and not specific to one button.

---

### Actual root cause (dispatch fix was not sufficient)

webview's JS shim sends `JSON.stringify(argumentsArray)` as `req`. The page
called `window.rpc(JSON.stringify({id,...}))`, so the host received
`["{\"id\":1,...}"]`: one string token. `json_value` never found `"id"`, and
`on_rpc` returned silently, every time. That is why the timeout was a constant
3s on the first call.

Fix: the page passes the object (`window.rpc({ id, method, params })`), so
`req` is `[{"id":1,...}]`. `on_rpc` now logs requests that have no id instead
of dropping them, and it calls `webview_return(seq, 0, "null")` so webview's own
per-call promise settles rather than leaking.

---

## `[object Object]`

The panic message carried no information.

### Cause

The rejected value was not an `Error`, and `String(obj)` gives `[object Object]`.
It was the symptom of the bug above: `rpc()` received `undefined` from a bound
function whose reply went to the wrong channel, `parseReplyObject` rejected it,
and the rejection held a plain value.

### Fix

`describe()` in `ui/panic.ts` renders any thrown value readably: stack for
`Error`, JSON for objects, literal text otherwise. Nothing reaching the user
should ever be `[object Object]` again.

---

## The page rendered as raw minified JavaScript

The window showed a wall of source instead of the editor.

### Cause

`html.replace(tag, \`<script>${js}</script>\`)` passed the replacement as a
**string**, so replacement patterns inside the bundle were expanded. Minified
CodeMirror contains `$&`, which means "the whole match" — the tag being
replaced. The result was a single inline `<script>` whose body contained literal
`<script type="module" src="./main.ts"></script>` text, and whose own
`</script>` terminated it early. Everything after became HTML text.

### Fix

A function replacer, which performs no pattern expansion:

```ts
const page = html.replace(tag, () => `<script>${js}</script>`);
```

Guarded by two tests: the page must have exactly one script open and one close,
and no `src="./main.ts"` may appear inside the bundle.

---

## `HOME not set and TEXT_EDIT_CACHE unset`

The program refused to start on Windows.

### Cause

The cache root defaulted to `$HOME/.cache/text-edit`, and `HOME` is frequently
unset on Windows.

### Fix

Falls back to `USERPROFILE`, giving `%USERPROFILE%\.cache\text-edit\`.
`TEXT_EDIT_CACHE` still overrides.

---

## Mojibake in the UI (`⌘` arriving as `â\x8c\x98`)

### Cause

Non-ASCII characters were written raw as UTF-8 into the C string literal for the
page, so the encoding depended on how the compiler read the source and how the
webview interpreted the bytes.

### Fix

`cLiteral` emits every byte outside printable ASCII as a three-digit octal
escape. The source file is pure ASCII; the runtime string carries the original
UTF-8. Guarded by a test that the generated header contains no non-ASCII.

---

## Startup failures reported only on stderr

A GUI-subsystem binary has no console, so `die()` wrote to a stream that does not
exist and the process simply vanished.

### Fix

`fatal()` shows a blocking native message box before exiting. Windows only;
elsewhere stderr is the channel. Rendering into the page is not an option here —
`webview_eval` is asynchronous and `exit()` beats it to the paint.

---

## `create` was never implemented

The New buttons called an RPC method the host did not have.

### Fix

`create` generates an id, opens the document through the same path as `open`
(writing the body and registering the core context), and replies with the id.

---

## Notes on reproduction

The first four were reproduced directly. The callback-thread bug was found by
building a harness that runs the real `host.c` against the real `main.ts` bundle
with a stub webview that can either dispatch synchronously or queue, then
feeding it RPC messages and executing the recorded `webview_eval` output in a
JS context.

Two things that harness cannot cover, because they need the real WebKit2GTK or
WebView2 library:

- whether `webview_dispatch` actually reaches the UI thread on a given platform
- whether the page's `_reply` handler is defined before the first eval lands

If a timeout survives the dispatch fix, those two are what to check next.

---

## `cannot write index.json`

### Cause

`write_atomic` wrote a temp file and called `rename()` over the target. On
Windows, the C runtime's `rename()` fails when the destination exists, so the
first save worked and every later one failed.

### Fix

On Windows, use `MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING |
MOVEFILE_WRITE_THROUGH)`. POSIX keeps `rename()`.

---

## `open: reply has no text`

### Cause

The host's `open` replied with `{length}` only. The page needs `{text}` to show
the document.

### Fix

`open` now sends back `{length, text}`, with the body JSON-escaped. The reply
buffer was 64 KiB and could not hold a full document. It is now sized for a
MAX_TEXT body escaped at worst 6x, and `reply_to_page` escapes into heap memory
instead of a 64 KiB stack array.

---

## `rpc: unknown method` (Cache folder button, Save)

### Cause

The page calls `reveal` and `save`. The C host never implemented either one.

### Fix

- `reveal` opens the cache root in the file manager: `ShellExecuteA` on
  Windows (links `shell32`), `open` on macOS, `xdg-open` elsewhere.
- `save` writes the document body and the index.

---

## Documents vanished on restart; `index.json` removed

### Cause

The host wrote `index.json` but never read it, so nothing reloaded documents
at startup.

### Fix

The index is gone. The directory is now the list of documents: each one is
`bodies/<name>.md`, the name is the id, and `load_bodies()` scans the directory
at startup. Rename is a file rename. Names follow Windows filename rules
everywhere and are compared without regard to case.

---

## Blank window on startup

### Cause

Adding every fenced-code language grew the page to 1.7 MB. `webview_set_html`
is WebView2's `NavigateToString` on Windows, which refuses documents over 2 MB.
The page is passed as UTF-16, so 1.7 MB of UTF-8 becomes about 3.4 MB.
webview 0.12 drops that error, so the window stayed blank with no message.

### Fix

- The page ships as two strings: the markup (about 6 KB) through `set_html`,
  and the script through `webview_init` (an init script, no size limit),
  started on DOMContentLoaded in the marked document only.
- Every webview call's return code is checked and fatal on failure; the
  declarations were `void`.
- No blank window is possible any more: the markup itself says "Loading...",
  a script that throws while loading renders its error, uncaught errors and
  rejections panic, and a host watchdog halts with a message box if the page
  has not reported `ready` within 15 s.
