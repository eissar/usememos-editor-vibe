# text-edit

Cross-platform desktop text editor. C host, delta arithmetic compiled by
[scriptc](https://scriptc.dev).

Local disk is a cache, never the source of truth. Every keystroke writes the body
through temp-file-and-rename and flushes metadata, so a hard kill loses nothing
typed. A cached body wins over an empty document on open.

## Build

```sh
./native/build.sh              # -> dist/text-edit
./native/build.sh --windows    # -> dist/text-edit-windows-x64.exe
```

No package manager step: the webview binaries are vendored in `native/vendor/`.

Linux needs WebKitGTK 6.0 at link time. Set `WEBVIEW_DEPS=skip` to link without
it and exercise the host against a stub.

Windows needs no Windows toolchain: Windows scriptc under Wine emits COFF objects
(`--emit=obj`, no linker, which is what avoids Wine's compilation-cache failure),
then host `zig cc -target x86_64-windows-gnu` links them against the prebuilt
runtime pack. `libwebview.def` generates the import library the DLL omits.

## Run

```sh
TEXT_EDIT_URL=http://127.0.0.1:3000/ ./dist/text-edit
```

The host does not serve the UI — it requires `TEXT_EDIT_URL` pointing at
something that does. No frontend ships in this repo; see Status. Linux needs WebKitGTK; Windows needs WebView2 and
`libwebview.dll` beside the executable. `TEXT_EDIT_CACHE` selects the cache root,
defaulting to `~/.cache/text-edit`.

## Layout

```
native/
  host.c        webview, RPC dispatch, document text, persistence
  abi.ts        delta validation and accounting (compiled by scriptc)
  profile.json  the ABI contract
  libwebview.def  import library for the Windows DLL
  build.sh      linux + windows builds
  vendor/       libwebview-x64.so, libwebview.dll (from webview-bun 2.4.0)
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

Work in progress. Documents persist locally; cloud sync is not wired up.

**No frontend.** `src/ui/` was deleted; the host drives whatever `TEXT_EDIT_URL`
points at. Nothing in this repo serves or builds that page.

**The window has never been opened.** There is no WebKitGTK on the Linux dev box
and no WebView2 in the Wine prefix, so only the message pipeline and persistence
are verified end to end.

[REVIEW.md](REVIEW.md) lists every outstanding bug, several of which are unfixed
memory-safety and data-loss defects. Read it before trusting this with anything
you care about.
