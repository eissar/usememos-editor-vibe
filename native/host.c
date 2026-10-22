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

#include "ui_html.h"

#ifdef _WIN32
#include <direct.h>
#include <process.h>
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
void webview_eval(webview_t *w, const char *js);
void webview_bind(webview_t *w, const char *name, webview_bind_cb fn, void *arg);
void webview_return(webview_t *w, const char *seq, int status, const char *result);

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

static void die(const char *msg) {
  /* No console on a GUI subsystem binary; the message still reaches Wine and
   * any attached debugger, and the exit code is the signal. */
  fprintf(stderr, "text-edit: %s\n", msg);
  exit(1);
}

/* --- tiny arena-free JSON helpers ---------------------------------------- */

/* Finds "key": in a flat JSON object and returns a pointer just past the colon. */
static const char *json_value(const char *json, const char *key) {
  char needle[64];
  snprintf(needle, sizeof needle, "\"%s\"", key);
  const char *at = strstr(json, needle);
  if (at == NULL) return NULL;
  at += strlen(needle);
  while (*at == ' ' || *at == '\t') at++;
  if (*at != ':') return NULL;
  at++;
  while (*at == ' ' || *at == '\t') at++;
  return at;
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

/* Percent-encodes anything outside [A-Za-z0-9._-] so an id cannot escape the
 * body directory or collide with the index. */
static void body_path(char *out, size_t cap, const char *id) {
  char safe[512];
  size_t w = 0;
  for (const char *p = id; *p != '\0' && w + 4 < sizeof safe; p++) {
    unsigned char c = (unsigned char)*p;
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
        c == '.' || c == '_' || c == '-') {
      safe[w++] = (char)c;
    } else {
      w += (size_t)snprintf(safe + w, sizeof safe - w, "%%%02X", c);
    }
  }
  safe[w] = '\0';
  char dir[1200];
  path_join(dir, sizeof dir, cache_root, "bodies");
  path_join(out, cap, dir, safe);
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
    if (home == NULL) die("HOME not set and TEXT_EDIT_CACHE unset");
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
static void save_index(void) {
  char path[1300];
  index_path(path, sizeof path);

  size_t cap = 4096 + (size_t)MAX_DOCS * 512;
  char *buf = malloc(cap);
  if (buf == NULL) die("out of memory");

  size_t w = (size_t)snprintf(buf, cap, "{\"version\":1,\"docs\":{");
  int first = 1;
  for (int i = 0; i < MAX_DOCS; i++) {
    if (!docs[i].in_use) continue;
    w += (size_t)snprintf(buf + w, cap - w, "%s\"%s\":{\"id\":\"%s\",\"length\":%zu}",
                          first ? "" : ",", docs[i].id, docs[i].id, docs[i].len);
    first = 0;
  }
  snprintf(buf + w, cap - w, "}}");

  if (!write_atomic(path, buf, strlen(buf))) die("cannot write index.json");
  free(buf);
}

static char *read_body(const char *id, size_t *len_out) {
  char path[1300];
  body_path(path, sizeof path, id);

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
  body_path(path, sizeof path, id);
  return write_atomic(path, d->text, d->len);
}

static doc_t *doc_open(const char *id) {
  doc_t *found = doc_find(id);
  if (found != NULL) return found;

  for (int i = 0; i < MAX_DOCS; i++) {
    if (docs[i].in_use) continue;
    docs[i].in_use = 1;
    snprintf(docs[i].id, sizeof docs[i].id, "%s", id);

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
      write_atomic_body(id);
    }

    core_ctx_open(i + 1);
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
  char *buf = malloc(base_len + MAX_TEXT);
  if (buf == NULL) die("out of memory");

  size_t at = 0, w = 0;
  for (int i = 0; i < n; i++) {
    size_t from = (size_t)rs[i].from;
    size_t to = (size_t)rs[i].to;
    if (from < at || from > base_len || to > base_len || to < from) {
      free(buf);
      return NULL;
    }
    while (at < from) buf[w++] = base[at++];
    const char *ins = inserts[i];
    while (ins != NULL && *ins != '\0') buf[w++] = *ins++;
    at = to;
  }
  while (at < base_len) buf[w++] = base[at++];
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

  if (strcmp(method, "open") == 0) {
    char id[128];
    if (!json_str(params, "id", id, sizeof id)) return "{\"error\":\"missing id\"}";
    doc_t *d = doc_open(id);
    if (d == NULL) return "{\"error\":\"too many documents\"}";
    snprintf(reply_buf, sizeof reply_buf, "{\"ok\":1,\"value\":{\"length\":%zu}}", d->len);
    return reply_buf;
  }

  if (strcmp(method, "close") == 0) {
    char id[128];
    if (!json_str(params, "id", id, sizeof id)) return "{\"error\":\"missing id\"}";
    write_atomic_body(id);
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
    json_int(params, "length", &claimed);

    /* Walk the ranges array once, collecting offsets and insert text. */
    range_t rs[MAX_RANGES];
    char *inserts[MAX_RANGES];
    int n = 0;

    const char *at = json_value(params, "ranges");
    if (at == NULL || *at != '[') return "{\"error\":\"missing ranges\"}";
    at++;

    while (*at != '\0' && *at != ']' && n < MAX_RANGES) {
      while (*at == ' ' || *at == ',') at++;
      if (*at == ']') break;

      int64_t from = 0, to = 0;
      char ins[MAX_TEXT];
      if (!json_int(at, "from", &from)) break;
      if (!json_int(at, "to", &to)) break;
      json_str(at, "insert", ins, sizeof ins);

      rs[n].from = from;
      rs[n].to = to;
      rs[n].insert_len = (int64_t)strlen(ins);
      inserts[n] = strdup(ins);
      if (inserts[n] == NULL) die("out of memory");
      n++;

      /* advance to the next object */
      const char *next = strchr(at, '}');
      if (next == NULL) break;
      at = next + 1;
    }

    int64_t handle = doc_handle(id);
    core_clear(handle);
    for (int i = 0; i < n; i++) {
      int64_t rc = core_push(handle, rs[i].from, rs[i].to, rs[i].insert_len);
      if ((uint64_t)rc != ABI_OK) {
        for (int j = 0; j < n; j++) free(inserts[j]);
        snprintf(reply_buf, sizeof reply_buf, "{\"error\":\"range\",\"code\":%lld}", (long long)rc);
        return reply_buf;
      }
    }

    int64_t verdict = core_validate(handle, (int64_t)d->len, claimed);
    if ((uint64_t)verdict != ABI_OK) {
      for (int j = 0; j < n; j++) free(inserts[j]);
      snprintf(reply_buf, sizeof reply_buf, "{\"error\":\"drift\",\"code\":%lld}", (long long)verdict);
      return reply_buf;
    }

    size_t new_len = 0;
    char *next_text = splice_with(d->text, d->len, rs, (const char *const *)inserts, n, &new_len);
    for (int j = 0; j < n; j++) free(inserts[j]);

    if (next_text == NULL) {
      return "{\"error\":\"range\"}";
    }

    free(d->text);
    d->text = next_text;
    d->len = new_len;
    core_clear(handle);

    /* Durability contract: once this returns, the bytes are on disk. */
    if (!write_atomic_body(id)) return "{\"error\":\"write failed\"}";
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

static void on_rpc(const char *seq, const char *req, void *arg) {
  (void)arg;

  char method[64];
  if (!json_str(req, "method", method, sizeof method)) {
    webview_return(g_window, seq, 1, "{\"error\":\"malformed\"}");
    return;
  }

  const char *params = json_value(req, "params");
  if (params == NULL) params = "{}";

  webview_return(g_window, seq, 0, dispatch(method, params));
}

int main(void) {
  core_init();
  cache_init();

  g_window = webview_create(getenv("TEXT_EDIT_DEBUG") != NULL, NULL);
  if (g_window == NULL) die("webview_create failed");

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
