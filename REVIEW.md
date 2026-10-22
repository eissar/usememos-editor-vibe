# Review

Everything wrong with this codebase, and every decision worth knowing.

Findings marked **verified** were confirmed against source before being written
down; findings marked **unverified** come from review but have not been
reproduced. Nothing here is fixed yet.

---

# Part 1 — Bugs

## Unfixed memory safety

### C1. `splice_with` overflows the heap — verified

`native/host.c:350–372`

```c
char *buf = malloc(base_len + MAX_TEXT);
...
while (at < from) buf[w++] = base[at++];
while (ins != NULL && *ins != '\0') buf[w++] = *ins++;
```

Capacity is `base_len + MAX_TEXT` (1 MiB slack). A batch may carry
`MAX_RANGES` (256) ranges with inserts of `MAX_TEXT` bytes each — 256 MiB of
insert against 1 MiB of slack. `w` is never bounds-checked. Reachable from page
input. `base_len + MAX_TEXT` can also wrap `size_t` for a very large body.

**Fix:** sum insert lengths first, reject when the total exceeds the cap, size
the buffer from the real output length, check `w` on every write.

### C2. `ins` is read uninitialized — verified

`native/host.c:434, 437, 441`

```c
char ins[MAX_TEXT];
...
json_str(at, "insert", ins, sizeof ins);   // return ignored
rs[n].insert_len = (int64_t)strlen(ins);
inserts[n] = strdup(ins);
```

A range with no `"insert"` key — a plain **deletion**, the common case — leaves
`ins` holding stack garbage. `json_str` returns 0 and nobody looks. `strlen`
then walks uninitialized memory. Undefined behaviour on the most frequent edit.

**Fix:** `ins[0] = '\0';` before the call, and check the return.

### C5. `save_index` can overflow its buffer — verified

`native/host.c:233–253`

```c
size_t w = (size_t)snprintf(buf, cap, ...);
w += (size_t)snprintf(buf + w, cap - w, ...);
```

`snprintf` returns the would-have-written length. Every `w +=` is unchecked, so
once the running total passes `cap`, `cap - w` underflows to a huge `size_t` and
the next `snprintf` writes out of bounds. Budget is a fixed `4096 + MAX_DOCS*512`
with nothing enforcing per-document output stays under 512. This is
`index.json` — the one file whose corruption loses every document.

**Fix:** check each `snprintf` return against remaining capacity; `die` or
realloc.

### H9. 1 MiB stack buffer in the RPC path — verified

`native/host.c:434`

`char ins[MAX_TEXT]` is a 1 MiB stack allocation inside the webview callback.
Windows' default thread stack is 1 MiB. One edit message can overflow it.

**Fix:** heap-allocate, or size from the parsed insert length.

## Unfixed data loss

### C3. Memory is committed before the durable write — verified

`native/host.c:478–485`

```c
free(d->text);
d->text = next_text;
d->len = new_len;
core_clear(handle);
if (!write_atomic_body(id)) return "{\"error\":\"write failed\"}";
```

The in-memory document is replaced *before* the write. If the write fails the
caller is told "write failed" while the host holds the new text. A retry
double-applies; a later save persists text the user was told was rejected.

**Fix:** write first, swap memory only on success.

### C4. `read_body` truncates silently on I/O error — verified

`native/host.c:255–283`

The read loop breaks on `n < 4096`, which is indistinguishable from EOF;
`ferror` is never checked, nor is `fclose`. A mid-file read error returns a short
buffer as success. The next edit splices against the truncated base and writes it
back — permanent loss. `MAX_TEXT` is defined but never enforced here, and
`cap *= 2` can wrap.

**Fix:** check `ferror`/`fclose`; cap growth at `MAX_TEXT`; guard the doubling.

### H7. Windows cannot replace a file on save — verified

`native/host.c:204–222`

POSIX `rename` replaces atomically; on Windows it fails when the target exists.
Every save after the first therefore fails. Needs
`MoveFileExA(..., MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`.

**Fix:** platform-specific replace, or `ReplaceFile`.

### H8. No `fsync` — the durability comment is false — verified

`native/host.c:204–222`

`fflush` reaches the OS, not the disk. The surrounding comment claims "once this
returns, the bytes are on disk." A power loss can leave a stale or empty file
renamed into place.

**Fix:** `fflush` → `fsync(fileno(f))` → close; `fsync` the directory after
rename.

## Unfixed correctness

### H1. `ctxOpen` returns the wrong value — verified

`native/abi.ts:62–67`

```ts
export function ctxOpen(ctx: number): number {
  tables.set(ctx, { items: [] });
  return Math.floor(tables.size) & MASK;   // table count, not ctx
}
```

Returns how many tables are open, not the caller's handle. Open ctx=7 then
ctx=3: returns 1 then 2, while the tables are keyed 7 and 3. A host using the
return as its handle operates on a different, empty document. Re-opening an
existing ctx also silently discards queued items.

**Fix:** return `ctx`; abort if already open.

### H2. `apply` clamps a negative length to 0 — verified

`native/abi.ts:95–111`

```ts
return length < 0 ? 0 : Math.floor(length) & MASK;
```

Deleting more than `baseLen` yields 0 — "document is empty" — as a **success**.
`validate` then compares against the host's expectation and can return OK for a
batch that deletes past the end. Silent truncation to empty.

**Fix:** `if (length < 0 || length > MASK) return MASK;`

### H3. `apply` never checks `hit.to <= baseLen` — verified

`native/abi.ts:103–109`

Offsets past the end are accepted and produce a plausible shorter length.
`splice_with` rejects them, but only by luck and with a generic error, after the
core has been left dirty.

**Fix:** bound `hit.from` and `hit.to` against `baseLen` inside the loop.

### H4. `whole()` masks negatives into huge positives — verified

`native/abi.ts:32–34`

```ts
function whole(n: number): number { return Math.floor(n) & MASK; }
```

`-1 & 0xffffffff === 4294967295`. `push` validates `from > to` on the *raw*
values before masking, so `push(ctx, -5, -3, 0)` passes and stores a near-4 GiB
range. `insertLen` is never sign-checked: a negative becomes ~4 GiB added to the
length. `NaN` coerces to 0.

**Fix:** reject non-integers, negatives and values above `MASK` before masking;
compare post-normalization.

### H5. Ids of `.` or `..` escape the body directory — verified

`native/host.c:157–173`

`body_path` percent-encodes anything outside `[A-Za-z0-9._-]`, so `.` and `..`
pass straight through. Id `..` yields `<root>/bodies/..` = `<root>`, defeating the
function's own stated guarantee. Ids longer than the 512-byte buffer are silently
truncated, so two distinct ids can map to one body file.

**Fix:** reject `.`/`..`; reject on truncation rather than truncating.

### H6. Index JSON is emitted without escaping — verified

`native/host.c:233–253`

`docs[i].id` is written raw. A decoded id containing `\` or a control byte
produces invalid JSON, and the next start cannot parse `index.json` — losing
every document.

**Fix:** JSON-escape ids in `save_index` and in the `list`/`open` replies.

### H10. A stale archive can produce a green build — verified

`native/build.sh:64, 81`

`"$SCRIPTC" build --lib --profile profile.json >/dev/null` discards output, and
nothing verifies `.scriptc/abi.lib.a` was rewritten. If scriptc exits 0 without
producing a fresh archive, `--whole-archive` links the *previous* build and the
build succeeds against stale core logic.

**Fix:** remove the archive before building; assert it exists and is newer than
the sources; keep compiler output.

### H11. `--unresolved-symbols=ignore-all` is unconstrained — verified

`native/build.sh:74`

`WEBVIEW_DEPS=skip` turns *every* unresolved symbol into a null pointer, not just
the intended WebKit stubs. A build can look fine and crash on first use.

**Fix:** after linking, diff `nm -u` against a known allowlist and fail otherwise.

## Medium — verified

| # | Where | Problem |
|---|---|---|
| M1 | host.c:329 | `write_atomic_body` return ignored when creating the initial body — the doc opens "successfully" with no file |
| M2 | host.c:332 | `core_ctx_open` return ignored — document usable with an invalid core context |
| M3 | host.c:342 | `core_ctx_close` return ignored — leaked context, slot later reused |
| M4 | host.c:481 | `core_clear` return ignored after a rejected push, leaving the core dirty |
| M5 | host.c:175–185 | `mkdir_p` path truncation unchecked — a shorter directory is created and reported as success |
| M6 | host.c:206 | temp-name truncation unchecked — temp/rename can mismatch |
| M7 | host.c:279 | `read_body` returns an extra NUL not counted in `len` (consistent today, fragile) |
| M8 | host.c:514 | params never verified to start with `{` — array params confuse the scanner |
| M9 | host.c:120–139 | `json_str` returns 1 on an unterminated string and silently drops characters past capacity while still reporting success |
| M10 | host.c:108–118 | `strtoll` overflow (`ERANGE`) and trailing garbage accepted as valid integers |
| M11 | abi.ts:122–130 | `validate` duplicates `apply`'s checks with different semantics; its `to < from` test is dead code |
| M12 | abi.ts:131 | `MASK` collapses doc-missing, overlap and the legitimate max length into one sentinel |
| M13 | abi.ts:53–60, 88 | `listFor` lazily *creates* on unknown ctx, so use-after-close becomes silent success |
| M14 | host.c:85 | `die()` is reachable from page input (long id, path, OOM), killing the process and losing all open documents |
| M15 | build.sh:24–30 | `*)` matches any typo — `./build.sh --window` silently builds Linux |

## Low

`snprintf` truncation unchecked at host.c:95, 150, 316, 494; `unlink` failures
ignored at 218; `fclose` unchecked at 281; empty `TEXT_EDIT_URL` not rejected at
520; `ABI_MASK` defined but never used (host.c:58) so masked codes are never
normalised as the header claims; `chmod` failure swallowed (build.sh:37); build
inputs default into `/tmp` with no authenticity check (build.sh:24–30); artifact
existence never verified (build.sh:88).

## Fixed during development

Kept because they are the kind of bug that comes back.

- **`core_init` never called** — the first `core_ctx_open` segfaulted inside
  `scr_map_set_f64_slot`. Found with gdb. Every library build must call it first.
- **Temp-file name collision** — `${pid}.${Date.now()}` produced one distinct
  name for 200 rapid calls, so concurrent writes raced and the loser's `rename`
  failed with ENOENT. Now a monotonic counter.
- **`ctxOpen` handle drift** — see H1.
- **`build.sh` did not create `dist/`** — a fresh clone failed to link.
- **Windows needs `_mkdir`**, not `mkdir`.
- **ScriptC's archive ships a stale `scr_alloc.o`** lacking `scr_sa_slow`; the
  link pulls `scr_async.o` from the runtime pack's matching variant instead.

---

# Part 2 — Design

## Why C, and why scriptc

The webview C API is callback-driven:

```c
void webview_bind(webview_t *w, const char *name, webview_bind_cb fn, void *arg);
```

scriptc's `--ffi` binds only scalar and pointer signatures, so it cannot express
that. C can, costs one small binary, and needs no interpreter.

Division of labour: **C owns the webview and the document text; the compiled core
owns delta arithmetic and batch validation.**

## The ABI

Seven exports, scalar-in and scalar-out.

| symbol | meaning |
|---|---|
| `core_ctx_open` / `core_ctx_close` / `core_ctx_count` | per-document slot table |
| `core_push` | queue one `(from, to, insertLen)` |
| `core_clear` | drop the queue |
| `core_validate` | `0`, `ERR_RANGE`, `ERR_DRIFT`, or `ERR_DOC` |

```
0  OK
1  ERR_DOC     no such slot
2  ERR_RANGE   overlapping or inverted ranges
3  ERR_DRIFT   batch length disagrees with the claim
MASK (0xffffffff) means "not applicable"
```

`ERR_RANGE` and `ERR_DRIFT` stay distinct: a range violation is a frontend bug,
drift is a stale batch. Both are rejected wholesale — a partially applied batch
would corrupt the document.

**Every `i64` return is masked** with `Math.floor(x) & 0xffffffff`. scriptc
rejects anything it cannot prove whole and in range: a bare constant fails with
*"the value may be NaN"*, and `a + b` fails with *"range failed: ±(2^53 − 1)"*.

**Strings do not cross.** scriptc's string ABI returns a runtime handle plus a
length and requires `core_init` first; every export writes into caller buffers
instead. Verified by disassembly: `rdi/rsi` = out ptr/cap, `rdx/rcx` = in
ptr/len, result via `scr_library_str_out`.

## Deltas

A batch's ranges all address the **original** document, so they are sorted by
`from` and applied left-to-right with a moving cursor. The wire format carries
insert text inline; the host splices it.

A keystroke sends `{ranges: [{from, to, insert}], length}` rather than the
document. On a 4 KB file that is 110 bytes instead of 4109 — **37x smaller**, and
the gap widens with size.

## Persistence

Bodies under `<root>/bodies/<id>`, metadata in `<root>/index.json`.
`TEXT_EDIT_CACHE` selects the root, defaulting to `~/.cache/text-edit`.

Every body write goes through a temp file and `rename`, and `index.json` is
rewritten atomically in full on every edit. On open, a cached body wins over an
empty document.

Verified round trip:

```
run 1  open + insert "hello" + " world"   -> length 11
       bodies/doc1                        -> "hello world"

run 2  reopen doc1                        -> length 11   (restored)
run 3  append "!" at offset 11            -> length 12
       bodies/doc1                        -> "hello world!"
```

Note this passes **despite H7 and H8**: `rename` over an existing file works on
Linux, and the runs are not interrupted by power loss.

## Building Windows without a Windows toolchain

scriptc has no cross-compile target, and Windows scriptc under Wine cannot create
its compilation cache (`manifest_create Unexpected`). So:

1. Wine + Windows scriptc emits **COFF objects** (`--emit=obj`) — no linker
   involved, which is what avoids the cache failure.
2. Host `zig cc -target x86_64-windows-gnu` links them against the 200 prebuilt
   COFF objects in the runtime pack.
3. `llvm-dlltool` generates the import library `libwebview.dll` ships without.

Runtime variants must be combined carefully: `library-release` has the library
entry points but no async runtime, `release` has `scr_async.o` but no library
entry points, `dyn-tier` replaces `default`'s `scr_json.o`, and `scr_wasm.o` is
excluded because its `scr_wasm_registry` is absent from the pack.

## Sizes

| | |
|---|---|
| linux host | 1.5 MB |
| windows host | 2.5 MB |
| previous Bun build | 111 MB |

## Error policy

No `throw`/`catch` in C. Expected failure returns a value; programmer error
calls `die()`. The frontend mirrors this in `src/ui/panic.ts`: `run()` turns a
rejected promise into a panic, and a panic halts rather than being swallowed —
`throw` alone is not enough, because from inside a promise callback Bun logs an
unhandled rejection and keeps running.

---

# Part 3 — Gaps

- **The window has never opened.** No WebKitGTK on the Linux dev box, no WebView2
  in the Wine prefix. `webview_create` returns NULL. Only the message pipeline and
  persistence are verified end to end. `cache_init` runs before window creation,
  which is why persistence is still exercised under Wine.
- **No cloud sync.** Debounce, conflict detection and eviction were in the deleted
  Bun host. Documents persist but never upload.
- **No `save`, `close` or `reveal` methods** in the C host.
- **The C host serves no UI.** It requires `TEXT_EDIT_URL` pointing at a server it
  does not provide; something else must serve `src/ui/`.
- **No tests.** The 45 Bun-host tests were deleted with it. The native side has
  none.
- **No CI.**
- **Not signed.** No code signing or notarisation on any platform.

---

# Part 4 — Method

The Part 1 findings came from three subagent reviews, one per file
(`native/host.c`, `native/abi.ts`, `native/build.sh`), running
`openrouter/deepseek/deepseek-v4.1-flash-1017` with no tools and file contents
embedded. They reported 154 raw items; the list above keeps those I could point
at in the source.

Reviewers could not run anything, so they could not falsify their own claims. I
verified every CRITICAL and HIGH by hand before recording it here, and dropped
those that did not hold up.

Line numbers were re-checked against the tree after the Bun host was deleted.
