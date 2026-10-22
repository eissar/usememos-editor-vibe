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
