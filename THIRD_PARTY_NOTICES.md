# Third-party notices

This project redistributes or bundles the following. All are under the MIT
license; see each project for its full license text.

| Component | Where | License |
|---|---|---|
| [webview](https://github.com/webview/webview) 0.12.0 (via [webview-bun](https://github.com/tr1ckydev/webview-bun) 2.4.0 prebuilt binaries) | `native/vendor/libwebview.dll`, `native/vendor/libwebview-x64.so` | MIT, Copyright (c) 2017 Serge Zaitsev; webview-bun Copyright (c) tr1ckydev |
| [CodeMirror 6](https://codemirror.net) (`@codemirror/*`) and [Lezer](https://lezer.codemirror.net) (`@lezer/*`) | bundled into the built page | MIT, Copyright (c) Marijn Haverbeke and others |

The compiled core is built with [scriptc](https://scriptc.dev); its runtime is
linked into the binaries under its own license terms.
