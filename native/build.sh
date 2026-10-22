#!/bin/sh
# Build the native host.
#
#   ./build.sh              linux binary
#   ./build.sh --windows    windows .exe (ScriptC emits COFF under Wine,
#                           host zig links it; no Windows toolchain needed)
#
# The compiled core is built twice because the two hosts need different object
# formats, and ScriptC has no cross-compile target of its own.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$here"

SCRIPTC=${SCRIPTC:-scriptc}
SCRIPTC_WIN=${SCRIPTC_WIN:-/tmp/scw/package/dist/bin/scriptc.exe}
RT_NATIVE=${SCRIPTC_RT:-/tmp/rtp/package/artifacts}
RT_WIN=${SCRIPTC_RT_WIN:-/tmp/scw/package/dist/lib/runtime-win32-x64-msvc/artifacts}

target=${1:-}

# The page is embedded, so it must be regenerated whenever the frontend changes.
# Removing the header first means a failed UI build cannot silently reuse a
# stale page.
rm -f ui_html.h
bun run ../ui/build.ts

mkdir -p ../dist

case "$target" in
--windows)
  [ -f "$SCRIPTC_WIN" ] || { echo "missing $SCRIPTC_WIN" >&2; exit 1; }
  chmod +x "$SCRIPTC_WIN" 2>/dev/null || true

  # Remove the archive first: scriptc exiting 0 without rewriting it would
  # otherwise link the previous build while reporting success.
  rm -f .scriptc/abi.lib.a
  printf 'compiling core (COFF, under wine)\n'
  wine "$SCRIPTC_WIN" build --lib --profile profile.json >/dev/null
  [ -s .scriptc/abi.lib.a ] || { echo "scriptc produced no archive" >&2; exit 1; }
  work=.win-build; rm -rf "$work"; mkdir -p "$work"
  ( cd "$work" && ar x ../.scriptc/abi.lib.a )

  printf 'collecting windows runtime\n'
  # library-release carries scr_library_i64_in (the library entry points);
  # release carries scr_async.o (the promise runtime). Neither alone links, so
  # take both. dyn-tier replaces the default scr_json.o, and scr_wasm.o is
  # excluded because its scr_wasm_registry is absent from the pack.
  : > "$work/order"
  echo "$RT_WIN/release/runtime/default/scr_async.o" >> "$work/order"
  echo "$RT_WIN/release/runtime/dyn-tier/scr_json.o" >> "$work/order"
  for f in "$RT_WIN"/library-release/runtime/default/*.o; do
    base=$(basename "$f")
    case "$base" in scr_wasm.o|scr_json.o) continue;; esac
    echo "$f" >> "$work/order"
  done

  # No import library ships with the DLL, so generate one from the .def.
  # libwebview.dll is MSVC-built; mingw can link against its import lib.
  zig dlltool -d libwebview.def -l "$work/libwebview.lib"

  printf 'linking\n'
  zig cc -target x86_64-windows-gnu \
    -Wl,--gc-sections -Wl,--subsystem,windows \
    host.c "$work/program.obj" $(cat "$work/order") "$RT_WIN"/vendor/*/*.a \
    "$work/libwebview.lib" \
    -ladvapi32 -liphlpapi -lws2_32 -lbcrypt -lcrypt32 -luserenv -lshell32 \
    -o ../dist/text-edit-windows-x64.exe
  printf 'built ../dist/text-edit-windows-x64.exe\n'
  ;;

*)
  # Remove the archive first: scriptc exiting 0 without rewriting it would
  # otherwise link the previous build while reporting success.
  rm -f .scriptc/abi.lib.a
  printf 'compiling core\n'
  "$SCRIPTC" build --lib --profile profile.json >/dev/null
  [ -s .scriptc/abi.lib.a ] || { echo "scriptc produced no archive" >&2; exit 1; }

  WV=${WEBVIEW_LIB:-vendor/libwebview-x64.so}
  [ -f "$WV" ] || { echo "missing $WV (set WEBVIEW_LIB)" >&2; exit 1; }

  # The webview library needs WebKitGTK at link time. When it is absent (CI,
  # headless dev boxes) WEBVIEW_DEPS=skip links without it so the host can be
  # exercised against a stub; a real build must resolve these.
  DEPS=""
  if [ "${WEBVIEW_DEPS:-link}" = "skip" ]; then
    DEPS="-Wl,--unresolved-symbols=ignore-all"
  fi

  # The archive ships an older scr_alloc.o that lacks scr_sa_slow, so the
  # runtime pack's scr_async.o comes from the same release variant.
  printf 'linking\n'
  cc -O2 -o ../dist/text-edit host.c \
    -Wl,--whole-archive .scriptc/abi.lib.a -Wl,--no-whole-archive \
    "$RT_NATIVE"/release/runtime/default/scr_async.o \
    "$WV" -lm -lpthread $DEPS -Wl,-rpath,'$ORIGIN'
  printf 'built ../dist/text-edit\n'
  ;;
esac

ls -lh ../dist/ | tail -2
