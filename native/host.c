/*
 * Native host for the editor.
 *
 * Owns the webview (callback-driven, so it cannot live in the compiled core)
 * and the document text. The compiled core does delta arithmetic and batch
 * validation; see abi.ts for that contract.
 *
 * Everything here is deliberately total: a malformed message from the page must
 * produce an error reply, never a crash. Expected failures return values;
 * programmer errors abort loudly, because a half-applied batch would corrupt
 * the user's file.
 */

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#include "ui_html.h"

#ifdef _WIN32
#include <direct.h>
#include <process.h>
#include <windows.h>
#define make_dir(p) _mkdir(p)
#define get_pid() _getpid()
#else
#include <unistd.h>
#define make_dir(p) mkdir((p), 0700)
#define get_pid() getpid()
#endif

/* webview C API. No header ships with bindings, so declare the surface used. */
typedef struct webview webview_t;
typedef void (*webview_bind_cb)(const char *seq, const char *req, void *arg);

webview_t *webview_create(int debug, void *window);
void webview_destroy(webview_t *w);
void webview_run(webview_t *w);
void webview_terminate(webview_t *w);
void webview_set_title(webview_t *w, const char *title);
void webview_set_size(webview_t *w, int width, int height, int hints);
void webview_set_html(webview_t *w, const char *html);
void *webview_get_window(webview_t *w);
void webview_eval(webview_t *w, const char *js);
void webview_bind(webview_t *w, const char *name, webview_bind_cb fn, void *arg);
void webview_return(webview_t *w, const char *seq, int status, const char *result);
int webview_dispatch(webview_t *w, void (*fn)(webview_t *w, void *arg), void *arg);

/* Compiled core (ScriptC). Scalar ABI only; negative codes are masked.
 *
 * core_init MUST run before any other call: it sets up the runtime's maps and
 * strings. Skipping it segfaults inside scr_map_set_f64_slot. */
void core_init(void);
int64_t core_ctx_open(int64_t ctx);
int64_t core_ctx_close(int64_t ctx);
int64_t core_ctx_count(void);
int64_t core_push(int64_t ctx, int64_t from, int64_t to, int64_t insert_len);
int64_t core_clear(int64_t ctx);
int64_t core_validate(int64_t ctx, int64_t base_len, int64_t expected);

#define ABI_MASK 0xffffffffULL
#define ABI_OK 0
#define ABI_ERR_DOC 1
#define ABI_ERR_RANGE 2
#define ABI_ERR_DRIFT 3
#define ABI_REJECT UINT32_MAX

#define MAX_DOCS 64
#define MAX_RANGES 256
#define MAX_TEXT (1u << 20)

typedef struct {
  int in_use;
  char id[128];
  char *text;
  size_t len;
} doc_t;

typedef struct {
  int64_t from;
  int64_t to;
  int64_t insert_len;
} range_t;

static doc_t docs[MAX_DOCS];
static webview_t *g_window;

/*
 * The single fatal path: report, then halt. There is no recovery.
 *
 * A GUI-subsystem binary has no console, so stderr on double-click goes
 * nowhere and the process looks like it simply failed to start. Rendering into
 * the page is not an option either: webview_eval is asynchronous and exit()
 * would beat it to the paint. The message therefore goes to a blocking native
 * surface plus stderr.
 */
static void fatal(const char *msg) {
  fprintf(stderr, "text-edit: %s\n", msg);

#ifdef _WIN32
  {
    char body[2048];
    snprintf(body, sizeof body,
             "%s\n\nIf this is the first run, check that the WebView2 runtime is "
             "installed:\nhttps://developer.microsoft.com/microsoft-edge/webview2/",
             msg);
    MessageBoxA(NULL, body, "text-edit", MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
  }
#endif

  exit(1);
}

static void die(const char *msg) {
  fatal(msg);
}

/* --- tiny arena-free JSON helpers ---------------------------------------- */

/*
 * Finds "key": and returns a pointer just past the colon.
 *
 * Scans member by member rather than strstr, so a document insert containing
 * `"from":` inside a string value cannot be mistaken for a range field. String
 * literals are skipped wholesale, escapes included.
 */
static const char *json_value(const char *json, const char *key) {
  size_t key_len = strlen(key);
  const char *at = json;

  while (*at != '\0') {
    if (*at == '"') {
      const char *start = ++at;
      while (*at != '\0' && *at != '"') {
        if (*at == '\\' && at[1] != '\0') at++;
        at++;
      }
      size_t len = (size_t)(at - start);
      if (*at == '"') at++;

      const char *scan = at;
      while (*scan == ' ' || *scan == '\t') scan++;
      if (*scan != ':') continue;

      if (len == key_len && strncmp(start, key, key_len) == 0) {
        scan++;
        while (*scan == ' ' || *scan == '\t') scan++;
        return scan;
      }
      continue;
    }

    at++;
  }
  return NULL;
}

static int json_int(const char *json, const char *key, int64_t *out) {
  const char *at = json_value(json, key);
  if (at == NULL) return 0;
  char *end = NULL;
  long long v = strtoll(at, &end, 10);
  if (end == at) return 0;
  *out = (int64_t)v;
  return 1;
}

/* Copies a JSON string value into buf; handles no escapes beyond \" and \\,
 * which is all the frontend emits for document ids. */
static int json_str(const char *json, const char *key, char *buf, size_t cap) {
  const char *at = json_value(json, key);
  if (at == NULL || *at != '"') return 0;
  at++;
  size_t n = 0;
  while (*at != '\0' && *at != '"') {
    if (*at == '\\' && at[1] != '\0') {
      at++;
      if (n + 1 < cap) buf[n++] = (*at == 'n') ? '\n' : *at;
      at++;
      continue;
    }
    if (n + 1 < cap) buf[n++] = *at;
    at++;
  }
  buf[n] = '\0';
  return 1;
}

/* --- persistence --------------------------------------------------------- */
/*
 * Mirrors the Bun host: bodies live under <root>/bodies/<id> and metadata in
 * <root>/index.json. Every write goes through a temp file and rename, so an
 * interrupted write leaves either the old content or the new one, never a
 * truncated file. Metadata is flushed on every edit; that is what makes a crash
 * lose nothing typed.
 */

static char cache_root[1024];

static void path_join(char *out, size_t cap, const char *a, const char *b) {
  int n = snprintf(out, cap, "%s/%s", a, b);
  if (n < 0 || (size_t)n >= cap) die("path too long");
}

/*
 * Percent-encodes anything outside [A-Za-z0-9._-] so an id cannot escape the
 * body directory or collide with the index.
 *
 * Ids come from the page, so a bad one is an expected failure and returns 0
 * rather than aborting: "." and ".." are inside the allowed set and would
 * otherwise resolve to the parent directory.
 */
static int body_path(char *out, size_t cap, const char *id) {
  if (strcmp(id, ".") == 0 || strcmp(id, "..") == 0) return 0;

  char safe[512];
  size_t w = 0;
  for (const char *p = id; *p != '\0'; p++) {
    unsigned char c = (unsigned char)*p;
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
        c == '.' || c == '_' || c == '-') {
      if (w + 2 > sizeof safe) return 0;
      safe[w++] = (char)c;
    } else {
      if (w + 4 > sizeof safe) return 0;
      w += (size_t)snprintf(safe + w, sizeof safe - w, "%%%02X", c);
    }
  }
  safe[w] = '\0';

  char dir[1200];
  path_join(dir, sizeof dir, cache_root, "bodies");
  path_join(out, cap, dir, safe);
  return 1;
}

static int mkdir_p(const char *path) {
  char tmp[1200];
  snprintf(tmp, sizeof tmp, "%s", path);
  for (char *p = tmp + 1; *p != '\0'; p++) {
    if (*p != '/') continue;
    *p = '\0';
    if (make_dir(tmp) != 0 && errno != EEXIST) return 0;
    *p = '/';
  }
  return make_dir(tmp) == 0 || errno == EEXIST;
}

static void cache_init(void) {
  const char *root = getenv("TEXT_EDIT_CACHE");

  if (root == NULL || *root == '\0') {
    const char *home = getenv("HOME");
#ifdef _WIN32
    /* HOME is frequently unset on Windows; USERPROFILE is the equivalent. */
    if (home == NULL || *home == '\0') home = getenv("USERPROFILE");
#endif
    if (home == NULL || *home == '\0') die("HOME not set and TEXT_EDIT_CACHE unset");
    snprintf(cache_root, sizeof cache_root, "%s/.cache/text-edit", home);
  } else {
    snprintf(cache_root, sizeof cache_root, "%s", root);
  }

  if (!mkdir_p(cache_root)) die("cannot create cache root");
  char bodies[1200];
  path_join(bodies, sizeof bodies, cache_root, "bodies");
  if (!mkdir_p(bodies)) die("cannot create bodies directory");
}

/* Writes `len` bytes to path via a temp file and rename. */
static int write_atomic(const char *path, const char *data, size_t len) {
  char tmp[1300];
  snprintf(tmp, sizeof tmp, "%s.%ld.tmp", path, (long)get_pid());

  FILE *f = fopen(tmp, "wb");
  if (f == NULL) return 0;
  size_t wrote = len == 0 ? 0 : fwrite(data, 1, len, f);
  int ok = (wrote == len) && (fflush(f) == 0);
  if (fclose(f) != 0) ok = 0;
  if (!ok) {
    unlink(tmp);
    return 0;
  }
  if (rename(tmp, path) != 0) {
    unlink(tmp);
    return 0;
  }
  return 1;
}

static void index_path(char *out, size_t cap) {
  path_join(out, cap, cache_root, "index.json");
}

/*
 * index.json is the one file whose corruption loses every document, so it is
 * rewritten atomically in full. Small enough that rewriting beats incremental
 * updates.
 */
/* Writes `in` as a JSON string body into `out`, escaping quotes, backslashes and
 * control bytes. Ids are arbitrary page input, so emitting them raw would
 * produce an unparseable index -- the one file whose corruption loses every
 * document. Returns 0 when the destination is too small. */
static int json_escape_to(char *out, size_t cap, const char *in, size_t *written) {
  size_t w = 0;
  for (const unsigned char *p = (const unsigned char *)in; *p != 0; p++) {
    if (*p == '"' || *p == '\\') {
      if (w + 3 > cap) return 0;
      out[w++] = '\\';
      out[w++] = (char)*p;
    } else if (*p < 0x20) {
      if (w + 7 > cap) return 0;
      w += (size_t)snprintf(out + w, cap - w, "\\u%04x", *p);
    } else {
      if (w + 2 > cap) return 0;
      out[w++] = (char)*p;
    }
  }
  out[w] = '\0';
  *written = w;
  return 1;
}

static void save_index(void) {
  char path[1300];
  index_path(path, sizeof path);

  size_t cap = 4096 + (size_t)MAX_DOCS * 1024;
  char *buf = malloc(cap);
  if (buf == NULL) die("out of memory");

  int w = snprintf(buf, cap, "{\"version\":1,\"docs\":{");
  if (w < 0) die("index format error");

  int first = 1;
  for (int i = 0; i < MAX_DOCS; i++) {
    if (!docs[i].in_use) continue;

    char key[1200];
    size_t key_len = 0;
    if (!json_escape_to(key, sizeof key, docs[i].id, &key_len)) die("document id too long");

    int m = snprintf(buf + w, cap - (size_t)w, "%s\"%s\":{\"id\":\"%s\",\"length\":%zu}",
                     first ? "" : ",", key, key, docs[i].len);
    if (m < 0 || (size_t)m >= cap - (size_t)w) die("index too large");
    w += m;
    first = 0;
  }

  int m = snprintf(buf + w, cap - (size_t)w, "}}");
  if (m < 0 || (size_t)m >= cap - (size_t)w) die("index too large");
  w += m;

  if (!write_atomic(path, buf, (size_t)w)) die("cannot write index.json");
  free(buf);
}

static char *read_body(const char *id, size_t *len_out) {
  char path[1300];
  if (!body_path(path, sizeof path, id)) return NULL;

  FILE *f = fopen(path, "rb");
  if (f == NULL) return NULL;

  size_t cap = 4096, len = 0;
  char *buf = malloc(cap);
  if (buf == NULL) die("out of memory");

  for (;;) {
    if (len + 4096 > cap) {
      cap *= 2;
      char *grown = realloc(buf, cap);
      if (grown == NULL) die("out of memory");
      buf = grown;
    }
    size_t n = fread(buf + len, 1, 4096, f);
    len += n;
    if (n < 4096) break;
  }
  fclose(f);

  buf[len] = '\0';
  *len_out = len;
  return buf;
}

/* --- document table ------------------------------------------------------ */

static doc_t *doc_find(const char *id) {
  for (int i = 0; i < MAX_DOCS; i++) {
    if (docs[i].in_use && strcmp(docs[i].id, id) == 0) return &docs[i];
  }
  return NULL;
}

static int64_t doc_handle(const char *id) {
  /* Handle is the slot index + 1, so 0 is always invalid. */
  for (int i = 0; i < MAX_DOCS; i++) {
    if (docs[i].in_use && strcmp(docs[i].id, id) == 0) return i + 1;
  }
  return -1;
}

static int write_atomic_body(const char *id) {
  doc_t *d = doc_find(id);
  if (d == NULL) return 0;
  char path[1300];
  if (!body_path(path, sizeof path, id)) return 0;
  return write_atomic(path, d->text, d->len);
}

static doc_t *doc_open(const char *id) {
  doc_t *found = doc_find(id);
  if (found != NULL) return found;

  /* Check the id maps to a legal body path before claiming a slot, so a bad id
   * is an open failure rather than a document backed by no file. */
  char probe[1300];
  if (!body_path(probe, sizeof probe, id)) return NULL;

  for (int i = 0; i < MAX_DOCS; i++) {
    if (docs[i].in_use) continue;

    if (snprintf(docs[i].id, sizeof docs[i].id, "%s", id) >= (int)sizeof docs[i].id) {
      return NULL;
    }
    docs[i].in_use = 1;

    /* A cached body wins over an empty document: the host is a cache of cloud
     * state, and the body is what the user last saw. */
    size_t len = 0;
    char *cached = read_body(id, &len);
    if (cached != NULL) {
      docs[i].text = cached;
      docs[i].len = len;
    } else {
      docs[i].text = calloc(1, 1);
      if (docs[i].text == NULL) die("out of memory");
      docs[i].len = 0;
      if (!write_atomic_body(id)) {
        free(docs[i].text);
        memset(&docs[i], 0, sizeof docs[i]);
        return NULL;
      }
    }

    int64_t handle = core_ctx_open(i + 1);
    if (handle != (int64_t)(i + 1)) {
      free(docs[i].text);
      memset(&docs[i], 0, sizeof docs[i]);
      return NULL;
    }
    save_index();
    return &docs[i];
  }
  return NULL;
}

static void doc_close(const char *id) {
  doc_t *d = doc_find(id);
  if (d == NULL) return;
  core_ctx_close(doc_handle(id));
  free(d->text);
  memset(d, 0, sizeof *d);
}

/* --- delta application --------------------------------------------------- */

/* Applies ranges whose inserts are already resolved into `insert_text`. */
static char *splice_with(const char *base, size_t base_len, const range_t *rs,
                         const char *const *inserts, int n, size_t *out_len) {
  /* Capacity must cover the base plus every insert, not a fixed slack: a batch
   * may carry MAX_RANGES inserts of up to MAX_TEXT each, so a constant
   * base_len + MAX_TEXT allowance overflows the heap. */
  size_t total_insert = 0;
  for (int i = 0; i < n; i++) {
    size_t ins_len = inserts[i] == NULL ? 0 : strlen(inserts[i]);
    if (total_insert > SIZE_MAX - ins_len) die("insert total overflow");
    total_insert += ins_len;
  }
  if (base_len > SIZE_MAX - total_insert) die("splice size overflow");
  size_t cap = base_len + total_insert;
  char *buf = malloc(cap + 1);
  if (buf == NULL) die("out of memory");

  size_t at = 0, w = 0;
  for (int i = 0; i < n; i++) {
    size_t from = (size_t)rs[i].from;
    size_t to = (size_t)rs[i].to;
    if (from < at || from > base_len || to > base_len || to < from) {
      free(buf);
      return NULL;
    }
    while (at < from) {
      if (w >= cap) { free(buf); return NULL; }
      buf[w++] = base[at++];
    }
    const char *ins = inserts[i];
    while (ins != NULL && *ins != '\0') {
      if (w >= cap) { free(buf); return NULL; }
      buf[w++] = *ins++;
    }
    at = to;
  }
  while (at < base_len) {
    if (w >= cap) { free(buf); return NULL; }
    buf[w++] = base[at++];
  }
  if (w > cap) { free(buf); return NULL; }
  buf[w] = '\0';
  *out_len = w;
  return buf;
}

/* --- dispatch ------------------------------------------------------------ */

static char reply_buf[1 << 16];

static const char *dispatch(const char *method, const char *params) {
  if (strcmp(method, "list") == 0) {
    size_t w = 0;
    w += snprintf(reply_buf + w, sizeof reply_buf - w, "{\"ok\":1,\"value\":[");
    int first = 1;
    for (int i = 0; i < MAX_DOCS; i++) {
      if (!docs[i].in_use) continue;
      w += snprintf(reply_buf + w, sizeof reply_buf - w,
                    "%s{\"id\":\"%s\",\"length\":%zu}", first ? "" : ",", docs[i].id, docs[i].len);
      first = 0;
    }
    snprintf(reply_buf + w, sizeof reply_buf - w, "]}");
    return reply_buf;
  }

  if (strcmp(method, "create") == 0) {
    char name[128];
    if (!json_str(params, "name", name, sizeof name)) {
      snprintf(name, sizeof name, "untitled.txt");
    }

    /* The host has no cloud identity to draw from, so the id is generated here
     * and stays stable for as long as the document exists on disk. */
    char id[128];
    static unsigned long counter;
    snprintf(id, sizeof id, "doc-%lu-%lu", (unsigned long)time(NULL), ++counter);

    doc_t *d = doc_open(id);
    if (d == NULL) return "{\"error\":\"cannot create\"}";

    snprintf(reply_buf, sizeof reply_buf, "{\"ok\":1,\"value\":{\"id\":\"%s\"}}", id);
    return reply_buf;
  }

  if (strcmp(method, "open") == 0) {
    char id[128];
    if (!json_str(params, "id", id, sizeof id)) return "{\"error\":\"missing id\"}";
    doc_t *d = doc_open(id);
    if (d == NULL) return "{\"error\":\"cannot open\"}";
    snprintf(reply_buf, sizeof reply_buf, "{\"ok\":1,\"value\":{\"length\":%zu}}", d->len);
    return reply_buf;
  }

  if (strcmp(method, "close") == 0) {
    char id[128];
    if (!json_str(params, "id", id, sizeof id)) return "{\"error\":\"missing id\"}";
    if (doc_find(id) != NULL && !write_atomic_body(id)) {
      return "{\"error\":\"write failed\"}";
    }
    save_index();
    doc_close(id);
    return "{\"ok\":1,\"value\":{}}";
  }

  if (strcmp(method, "edit") == 0) {
    char id[128];
    if (!json_str(params, "id", id, sizeof id)) return "{\"error\":\"missing id\"}";
    doc_t *d = doc_find(id);
    if (d == NULL) return "{\"error\":\"unknown doc\"}";

    int64_t claimed = 0;
    if (!json_int(params, "length", &claimed)) return "{\"error\":\"missing length\"}";

    /* The frontend sends the pre-change length alongside the post-change one.
     * Ranges address the ORIGINAL document, so the base is what we must splice
     * against -- using the new length would misplace every edit that changed
     * the document's size. */
    int64_t base_len = 0;
    if (json_int(params, "baseLength", &base_len)) {
      if (base_len != (int64_t)d->len) {
        return "{\"error\":\"stale\",\"code\":3}";
      }
    } else {
      base_len = (int64_t)d->len;
    }

    range_t rs[MAX_RANGES];
    char **inserts = calloc(MAX_RANGES, sizeof *inserts);
    if (inserts == NULL) die("out of memory");
    int n = 0;

    const char *at = json_value(params, "ranges");
    if (at == NULL || *at != '[') return "{\"error\":\"missing ranges\"}";
    at++;

    int bad = 0;
    while (*at != '\0' && *at != ']' && n < MAX_RANGES) {
      while (*at == ' ' || *at == ',') at++;
      if (*at == ']') break;

      int64_t from = 0, to = 0;
      char *ins = calloc(1, MAX_TEXT);
      if (ins == NULL) die("out of memory");

      if (!json_int(at, "from", &from) || !json_int(at, "to", &to)) {
        free(ins);
        bad = 1;
        break;
      }
      json_str(at, "insert", ins, MAX_TEXT);

      rs[n].from = from;
      rs[n].to = to;
      rs[n].insert_len = (int64_t)strlen(ins);
      inserts[n] = ins;
      n++;

      const char *next = strchr(at, '}');
      if (next == NULL) { bad = 1; break; }
      at = next + 1;
    }

    if (bad || n == 0) {
      for (int j = 0; j < n; j++) free(inserts[j]);
      free(inserts);
      return "{\"error\":\"malformed ranges\"}";
    }

    int64_t handle = doc_handle(id);
    int64_t rc = core_clear(handle);
    if (rc != ABI_OK) {
      for (int j = 0; j < n; j++) free(inserts[j]);
      free(inserts);
      snprintf(reply_buf, sizeof reply_buf, "{\"error\":\"range\",\"code\":%lld}", (long long)rc);
      return reply_buf;
    }

    for (int i = 0; i < n; i++) {
      rc = core_push(handle, rs[i].from, rs[i].to, rs[i].insert_len);
      if (rc != ABI_OK) {
        for (int j = 0; j < n; j++) free(inserts[j]);
        free(inserts);
        core_clear(handle);
        snprintf(reply_buf, sizeof reply_buf, "{\"error\":\"range\",\"code\":%lld}", (long long)rc);
        return reply_buf;
      }
    }

    int64_t verdict = core_validate(handle, base_len, claimed);
    if (verdict != ABI_OK) {
      for (int j = 0; j < n; j++) free(inserts[j]);
      free(inserts);
      core_clear(handle);
      snprintf(reply_buf, sizeof reply_buf, "{\"error\":\"drift\",\"code\":%lld}", (long long)verdict);
      return reply_buf;
    }

    size_t new_len = 0;
    char *next_text = splice_with(d->text, d->len, rs, (const char *const *)inserts, n, &new_len);
    for (int j = 0; j < n; j++) free(inserts[j]);
    free(inserts);

    if (next_text == NULL) {
      core_clear(handle);
      return "{\"error\":\"range\"}";
    }
    if (new_len != (size_t)claimed) {
      free(next_text);
      core_clear(handle);
      return "{\"error\":\"drift\",\"code\":3}";
    }

    /* Durability: the body must be on disk before the in-memory copy moves, or
     * a failed write leaves the host holding text the caller was told was
     * rejected -- a retry would then apply it twice. */
    char *previous = d->text;
    size_t previous_len = d->len;
    d->text = next_text;
    d->len = new_len;

    if (!write_atomic_body(id)) {
      d->text = previous;
      d->len = previous_len;
      free(next_text);
      core_clear(handle);
      return "{\"error\":\"write failed\"}";
    }

    free(previous);
    core_clear(handle);
    save_index();

    snprintf(reply_buf, sizeof reply_buf, "{\"ok\":1,\"value\":{\"length\":%zu}}", d->len);
    return reply_buf;
  }

  if (strcmp(method, "status") == 0) {
    int open = 0;
    for (int i = 0; i < MAX_DOCS; i++) open += docs[i].in_use;
    snprintf(reply_buf, sizeof reply_buf, "{\"ok\":1,\"value\":{\"open\":%d,\"compiled\":%lld}}",
             open, (long long)core_ctx_count());
    return reply_buf;
  }

  return "{\"error\":\"unknown method\"}";
}

/* --- webview plumbing ---------------------------------------------------- */

/* Escapes for a single-quoted JS string literal. Only backslash, the quote
 * itself and control bytes need replacing; JSON is already ASCII-safe. */
static void js_escape_single(char *out, size_t cap, const char *in) {
  size_t w = 0;
  for (const unsigned char *p = (const unsigned char *)in; *p != 0; p++) {
    if (*p == '\\' || *p == '\'') {
      if (w + 3 > cap) break;
      out[w++] = '\\';
      out[w++] = (char)*p;
    } else if (*p == '\n') {
      if (w + 3 > cap) break;
      out[w++] = '\\';
      out[w++] = 'n';
    } else if (*p == '\r') {
      if (w + 3 > cap) break;
      out[w++] = '\\';
      out[w++] = 'r';
    } else if (*p < 0x20) {
      if (w + 7 > cap) break;
      w += (size_t)snprintf(out + w, cap - w, "\\u%04x", *p);
    } else {
      if (w + 2 > cap) break;
      out[w++] = (char)*p;
    }
  }
  out[w] = '\0';
}

/* Payload for a reply that must run on the UI thread. */
typedef struct {
  char *script;
} eval_job;

static void eval_on_main(webview_t *w, void *arg) {
  eval_job *job = (eval_job *)arg;
  webview_eval(w, job->script);
  free(job->script);
  free(job);
}

/*
 * Delivers a reply to the page.
 *
 * webview_bind callbacks run on the webview's own callback thread, where
 * webview_eval does not execute (the UI thread owns the document), so the eval
 * is posted through webview_dispatch instead. Evaluating directly there was the
 * reason every reply was lost and every call timed out.
 */
static void reply_to_page(int64_t id, const char *json) {
  char escaped[(1 << 16) + 64];
  js_escape_single(escaped, sizeof escaped, json);

  size_t need = strlen(escaped) + 64;
  eval_job *job = malloc(sizeof *job);
  if (job == NULL) die("out of memory");
  job->script = malloc(need);
  if (job->script == NULL) die("out of memory");

  snprintf(job->script, need, "window.rpc._reply(%lld,'%s')", (long long)id, escaped);

  if (webview_dispatch(g_window, eval_on_main, job) != 0) {
    free(job->script);
    free(job);
    die("could not queue a reply for the page");
  }
}

static void on_rpc(const char *seq, const char *req, void *arg) {
  (void)seq;
  (void)arg;

  int64_t id = 0;
  if (!json_int(req, "id", &id)) return;

  char method[64];
  if (!json_str(req, "method", method, sizeof method)) {
    reply_to_page(id, "{\"error\":\"malformed\"}");
    return;
  }

  const char *params = json_value(req, "params");
  if (params == NULL) params = "{}";

  reply_to_page(id, dispatch(method, params));
}

int main(void) {
  core_init();
  cache_init();

  g_window = webview_create(getenv("TEXT_EDIT_DEBUG") != NULL, NULL);
  if (g_window == NULL) {
    die("could not create the window (webview_create returned null)");
  }

  /* A non-null handle does not prove a window exists: the platform can hand
   * back a context whose native window failed to appear, which is exactly the
   * "starts and shows nothing" symptom. Check the handle itself. */
  if (webview_get_window(g_window) == NULL) {
    die("the window was created but has no native handle");
  }

  if (UI_HTML == NULL || UI_HTML[0] == '\0') {
    die("the embedded UI is empty - ui/build.ts did not run");
  }

  webview_set_title(g_window, "text-edit");
  webview_set_size(g_window, 1100, 720, 0);
  webview_bind(g_window, "rpc", on_rpc, NULL);
  webview_set_html(g_window, UI_HTML);

  webview_run(g_window);

  for (int i = 0; i < MAX_DOCS; i++) {
    if (docs[i].in_use) free(docs[i].text);
  }
  webview_destroy(g_window);
  return 0;
}
