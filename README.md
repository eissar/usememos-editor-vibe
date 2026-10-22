# text-edit

Cross-platform desktop text editor. C host, delta arithmetic compiled by
[scriptc](https://scriptc.dev).

Each document is `memos/<id>.md` under the cache root, and the directory
listing is the document list. Ids are `local-<random>` until a document has a
cloud memo, then the memo id. Documents have no names: a tab shows the first
line of the text. Edits are held
in the page and written after 3 s without typing (a red `*` marks the tab
meanwhile); Ctrl+S, switching tabs, renaming, closing and the window losing focus write
immediately. When the window regains focus the host rescans `memos/`: new
files open, deleted ones close, and files changed elsewhere reload. Nothing
polls.

Every `memos/*.md` file is a tab; a tab exists exactly as long as its file.
Documents are cloud memos opened from Browse, kept as `memos/<memo id>.md`.
Each one's cloud state (the memo's `updateTime` and a hash of the text the
cloud holds) lives in `memos/.sync/<id>`, so a document is synced when its
text hashes to that value.

A push runs 10 s after the last save: the page fetches the memo, refuses if
its `updateTime` moved since the last pull or push (changed in the cloud), else
PATCHes the content and records the new `updateTime`. Failed pushes retry when
the window regains focus. Closing a tab deletes only the local file and is
refused until the document is synced. The tab shows `^` while waiting and a red
`!` when a push failed (hover for the reason). A `*` marks unsaved edits and turns red if the save is late. Marks read
`*` then `^`/`!` in a fixed-width slot.
Writes go through temp-file-and-rename.

## Build

```sh
./native/build.sh              # -> dist/text-edit
./native/build.sh --windows    # -> dist/text-edit-windows-x64.exe
```

The webview binaries are vendored in `native/vendor/`. The page is bundled with bun.

Linux needs WebKitGTK 6.0 at link time. Set `WEBVIEW_DEPS=skip` to link without
it and exercise the host against a stub.

Windows needs no Windows toolchain: Windows scriptc under Wine emits COFF objects
(`--emit=obj`, no linker, which is what avoids Wine's compilation-cache failure),
then host `zig cc -target x86_64-windows-gnu` links them against the prebuilt
runtime pack. `libwebview.def` generates the import library the DLL omits.

## Run

```sh
./dist/text-edit
```

No server and no URL: the page is bundled and embedded at build time, then handed
to the webview with `webview_set_html`.

Linux needs WebKitGTK; Windows needs WebView2 and `libwebview.dll` beside the
executable. `TEXT_EDIT_CACHE` selects the cache root, defaulting to
`~/.cache/text-edit`.

Required: `MEMOS_BASE_URL` (e.g. `http://host:5230`) and `MEMOS_KEY` (a Memos
access token). Startup fails with a message naming any that are missing or
empty. On Windows set them with `setx` and start from a new session. Optional:
`MEMOS_API_PREFIX` (`/api/v1` by default; `/api` for newer Memos).

## Layout

```
native/
  host.c        webview, RPC dispatch, document text, persistence
  abi.ts        delta validation and accounting (compiled by scriptc)
  profile.json  the ABI contract
  libwebview.def  import library for the Windows DLL
  build.sh      linux + windows builds
  vendor/       libwebview-x64.so, libwebview.dll (from webview-bun 2.4.0)
  ui_html.h     generated: the bundled page as a C literal
ui/
  editor.ts     CodeMirror state factories
  main.ts       tabs, editor mount, rpc() client
  index.html    page shell
  panic.ts      panic / assert / run / describe
  usememos_api.ts  Memos REST client
  browser.ts    paginated memo viewer (Browse); click an id to open it
  build.ts      bundles ui/ -> native/ui_html.h
```

## Design

The webview C API is callback-driven (`webview_bind` takes a function pointer).
scriptc's `--ffi` binds only scalar and pointer signatures, so the callbacks live
in C and the arithmetic lives in compiled TypeScript. Text is owned by C; the
compiled side only decides whether a delta batch is applicable and what length it
produces.

A keystroke sends `{ranges: [{from, to, insert}], length}` rather than the
document — on a 4 KB file, 110 bytes instead of 4109. All ranges in a batch
address the **original** document, so they are sorted before arithmetic and
applied left-to-right with a moving cursor.

Every compiled export is scalar-in, scalar-out, and every `i64` return is masked
so its range is provable — scriptc rejects anything it cannot prove whole.

No throws or catches in C: expected failure returns a value, programmer error
calls `die()`. `ERR_RANGE` (frontend bug) stays distinct from `ERR_DRIFT` (stale
batch).

| | size |
|---|---|
| linux host | 1.5 MB |
| windows host | 2.5 MB |

## Status

Prototype. Runs on Windows. There is no WebKitGTK on the Linux dev box, so the
Linux host is only exercised against a stub webview.
