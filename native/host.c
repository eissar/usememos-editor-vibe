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
#include <shellapi.h>
#define make_dir(p) _mkdir(p)
#define get_pid() _getpid()
#define strncasecmp _strnicmp
#define strcasecmp _stricmp
#else
#include <dirent.h>
#include <strings.h>
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
 * Each document is <root>/bodies/<id>.md, and the directory listing is the list
 * of documents. Every write goes through a temp file and rename, so an
 * interrupted write leaves either the old content or the new one, never a
 * truncated file. Bodies are written on every edit, so a crash loses nothing
 * typed.
 */

static char cache_root[1024];

static void path_join(char *out, size_t cap, const char *a, const char *b) {
  int n = snprintf(out, cap, "%s/%s", a, b);
  if (n < 0 || (size_t)n >= cap) die("path too long");
}

/*
 * A document's id is its name, and its body is <root>/bodies/<name>.md.
 *
 * Names must be valid filenames on every platform, so the Windows rules apply
 * everywhere: printable ASCII only, none of <>:"/\|?*, no leading or trailing
 * space or dot, and none of the reserved device names (CON, NUL, COM1, ...).
 * Non-ASCII is refused because the host uses the ANSI file APIs on Windows,
 * which would mangle UTF-8.
 */
#define MAX_NAME 100

static int name_valid(const char *name) {
  size_t n = strlen(name);
  if (n == 0 || n > MAX_NAME) return 0;
  if (name[0] == ' ' || name[0] == '.' || name[n - 1] == ' ' || name[n - 1] == '.') return 0;
  for (const unsigned char *p = (const unsigned char *)name; *p != 0; p++) {
    if (*p < 0x20 || *p > 0x7e) return 0;
    if (strchr("<>:\"/\\|?*", *p) != NULL) return 0;
  }

  /* Reserved device names, with or without an extension ("nul.txt" too). */
  static const char *reserved[] = {"CON", "PRN", "AUX", "NUL"};
  size_t stem = strcspn(name, ".");
  for (size_t i = 0; i < sizeof reserved / sizeof reserved[0]; i++) {
    if (stem == 3 && strncasecmp(name, reserved[i], 3) == 0) return 0;
  }
  if (stem == 4 && (strncasecmp(name, "COM", 3) == 0 || strncasecmp(name, "LPT", 3) == 0) &&
      name[3] >= '1' && name[3] <= '9') {
    return 0;
  }
  return 1;
}

static int body_path(char *out, size_t cap, const char *id) {
  if (!name_valid(id)) return 0;
  char file[MAX_NAME + 8];
  snprintf(file, sizeof file, "%s.md", id);
  char dir[1200];
  path_join(dir, sizeof dir, cache_root, "bodies");
  path_join(out, cap, dir, file);
  return 1;
}

static int file_exists(const char *path) {
  struct stat st;
  return stat(path, &st) == 0;
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
#ifdef _WIN32
  /* The CRT's rename() will not replace an existing file on Windows. */
  if (!MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
#else
  if (rename(tmp, path) != 0) {
#endif
    unlink(tmp);
    return 0;
  }
  return 1;
}

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

/* Case-insensitive, as Windows file names are: "Notes" and "notes" are the
 * same document. */
static doc_t *doc_find(const char *id) {
  for (int i = 0; i < MAX_DOCS; i++) {
    if (docs[i].in_use && strcasecmp(docs[i].id, id) == 0) return &docs[i];
  }
  return NULL;
}

static int64_t doc_handle(const char *id) {
  /* Handle is the slot index + 1, so 0 is always invalid. */
  for (int i = 0; i < MAX_DOCS; i++) {
    if (docs[i].in_use && strcasecmp(docs[i].id, id) == 0) return i + 1;
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

/* --- startup scan -------------------------------------------------------- */
/* Temp files from an interrupted write end in .tmp, so the .md suffix check
 * skips them. */
static int has_suffix(const char *s, const char *suf) {
  size_t a = strlen(s), b = strlen(suf);
  return a >= b && strcmp(s + a - b, suf) == 0;
}

static int cmp_str(const void *a, const void *b) {
  return strcmp(*(char *const *)a, *(char *const *)b);
}

static void consider_entry(const char *name, char **ids, int *n) {
  if (*n >= MAX_DOCS || !has_suffix(name, ".md")) return;
  char id[MAX_NAME + 1];
  size_t len = strlen(name) - 3;
  if (len == 0 || len >= sizeof id) return;
  memcpy(id, name, len);
  id[len] = '\0';
  if (!name_valid(id)) return;

  ids[*n] = malloc(len + 1);
  if (ids[*n] == NULL) die("out of memory");
  memcpy(ids[*n], id, len + 1);
  (*n)++;
}

static void load_bodies(void) {
  char dir[1200];
  path_join(dir, sizeof dir, cache_root, "bodies");

  char *ids[MAX_DOCS];
  int n = 0;

#ifdef _WIN32
  char pattern[1300];
  path_join(pattern, sizeof pattern, dir, "*");
  WIN32_FIND_DATAA fd;
  HANDLE h = FindFirstFileA(pattern, &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
      consider_entry(fd.cFileName, ids, &n);
    } while (FindNextFileA(h, &fd));
    FindClose(h);
  }
#else
  DIR *d = opendir(dir);
  if (d != NULL) {
    struct dirent *e;
    while ((e = readdir(d)) != NULL) consider_entry(e->d_name, ids, &n);
    closedir(d);
  }
#endif

  qsort(ids, (size_t)n, sizeof ids[0], cmp_str);
  for (int i = 0; i < n; i++) {
    if (doc_open(ids[i]) == NULL) fprintf(stderr, "text-edit: could not load %s\n", ids[i]);
    free(ids[i]);
  }
}

/* --- dispatch ------------------------------------------------------------ */

/* Large enough for an `open` reply: a MAX_TEXT body escaped at worst 6x. */
#define REPLY_CAP ((size_t)MAX_TEXT * 6 + 4096)
static char reply_buf[REPLY_CAP];

static const char *dispatch(const char *method, const char *params) {
  if (strcmp(method, "list") == 0) {
    size_t w = 0;
    w += snprintf(reply_buf + w, sizeof reply_buf - w, "{\"ok\":1,\"value\":[");
    int first = 1;
    for (int i = 0; i < MAX_DOCS; i++) {
      if (!docs[i].in_use) continue;
      char name[800];
      size_t nl = 0;
      if (!json_escape_to(name, sizeof name, docs[i].id, &nl)) {
        snprintf(name, sizeof name, "%s", docs[i].id);
      }
      w += snprintf(reply_buf + w, sizeof reply_buf - w,
                    "%s{\"id\":\"%s\",\"name\":\"%s\",\"state\":\"clean\",\"length\":%zu}",
                    first ? "" : ",", docs[i].id, name, docs[i].len);
      first = 0;
    }
    snprintf(reply_buf + w, sizeof reply_buf - w, "]}");
    return reply_buf;
  }

  if (strcmp(method, "create") == 0) {
    char base[MAX_NAME + 1];
    if (!json_str(params, "name", base, sizeof base) || !name_valid(base)) {
      snprintf(base, sizeof base, "untitled");
    }

    /* First free name of "base", "base 2", "base 3", ... -- free meaning
     * neither open nor on disk (closed documents keep their files). */
    char id[MAX_NAME + 16];
    char path[1300];
    int found = 0;
    for (int k = 1; k < 10000 && !found; k++) {
      if (k == 1) snprintf(id, sizeof id, "%s", base);
      else snprintf(id, sizeof id, "%s %d", base, k);
      if (!body_path(path, sizeof path, id)) continue;
      found = doc_find(id) == NULL && !file_exists(path);
    }
    if (!found) return "{\"error\":\"no free name\"}";

    doc_t *d = doc_open(id);
    if (d == NULL) return "{\"error\":\"cannot create\"}";

    snprintf(reply_buf, sizeof reply_buf, "{\"ok\":1,\"value\":{\"id\":\"%s\"}}", id);
    return reply_buf;
  }

  if (strcmp(method, "rename") == 0) {
    char id[MAX_NAME + 16], to[256];
    if (!json_str(params, "id", id, sizeof id)) return "{\"error\":\"missing id\"}";
    if (!json_str(params, "name", to, sizeof to)) return "{\"error\":\"missing name\"}";
    doc_t *d = doc_find(id);
    if (d == NULL) return "{\"error\":\"unknown doc\"}";
    if (!name_valid(to)) {
      return "{\"error\":\"invalid name: use letters, digits and spaces; not <>:\\\"/\\\\|?* or a trailing dot\"}";
    }

    char from_path[1300], to_path[1300];
    if (!body_path(from_path, sizeof from_path, d->id)) return "{\"error\":\"bad id\"}";
    if (!body_path(to_path, sizeof to_path, to)) return "{\"error\":\"invalid name\"}";

    /* A case-only change ("notes" -> "Notes") is the same file on Windows and
     * must not be treated as a collision with itself. */
    int same_doc = strcasecmp(d->id, to) == 0;
    if (!same_doc && (doc_find(to) != NULL || file_exists(to_path))) {
      return "{\"error\":\"a document with that name already exists\"}";
    }

    if (strcmp(d->id, to) != 0) {
      /* Flush first so the renamed file carries the latest text. */
      if (!write_atomic_body(d->id)) return "{\"error\":\"write failed\"}";
#ifdef _WIN32
      if (!MoveFileExA(from_path, to_path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
#else
      if (rename(from_path, to_path) != 0) {
#endif
        return "{\"error\":\"rename failed\"}";
      }
      snprintf(d->id, sizeof d->id, "%s", to);
    }

    snprintf(reply_buf, sizeof reply_buf, "{\"ok\":1,\"value\":{\"id\":\"%s\"}}", d->id);
    return reply_buf;
  }

  if (strcmp(method, "open") == 0) {
    char id[128];
    if (!json_str(params, "id", id, sizeof id)) return "{\"error\":\"missing id\"}";
    doc_t *d = doc_open(id);
    if (d == NULL) return "{\"error\":\"cannot open\"}";
    size_t w = (size_t)snprintf(reply_buf, sizeof reply_buf, "{\"ok\":1,\"value\":{\"length\":%zu,\"text\":\"", d->len);
    size_t esc = 0;
    if (!json_escape_to(reply_buf + w, sizeof reply_buf - w - 8, d->text, &esc)) {
      return "{\"error\":\"document too large to send\"}";
    }
    w += esc;
    snprintf(reply_buf + w, sizeof reply_buf - w, "\"}}");
    return reply_buf;
  }

  if (strcmp(method, "close") == 0) {
    char id[128];
    if (!json_str(params, "id", id, sizeof id)) return "{\"error\":\"missing id\"}";
    if (doc_find(id) != NULL && !write_atomic_body(id)) {
      return "{\"error\":\"write failed\"}";
    }
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

    snprintf(reply_buf, sizeof reply_buf, "{\"ok\":1,\"value\":{\"length\":%zu}}", d->len);
    return reply_buf;
  }

  if (strcmp(method, "save") == 0) {
    char id[128];
    if (!json_str(params, "id", id, sizeof id)) return "{\"error\":\"missing id\"}";
    if (doc_find(id) == NULL) return "{\"error\":\"unknown doc\"}";
    if (!write_atomic_body(id)) return "{\"error\":\"write failed\"}";
    return "{\"ok\":1,\"value\":{}}";
  }

  if (strcmp(method, "reveal") == 0) {
#ifdef _WIN32
    if ((INT_PTR)ShellExecuteA(NULL, "open", cache_root, NULL, NULL, SW_SHOWNORMAL) <= 32) {
      return "{\"error\":\"could not open the cache folder\"}";
    }
#else
    char cmd[1200];
#ifdef __APPLE__
    snprintf(cmd, sizeof cmd, "open '%s' &", cache_root);
#else
    snprintf(cmd, sizeof cmd, "xdg-open '%s' >/dev/null 2>&1 &", cache_root);
#endif
    if (system(cmd) != 0) return "{\"error\":\"could not open the cache folder\"}";
#endif
    snprintf(reply_buf, sizeof reply_buf, "{\"ok\":1,\"value\":{}}");
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

/* Replies by evaluating window.rpc._reply(id, json) in the page, posted
 * through webview_dispatch so the eval runs on the UI thread. */
static void reply_to_page(int64_t id, const char *json) {
  /* An `open` reply can be megabytes, and escaping can double it. */
  size_t ecap = strlen(json) * 2 + 64;
  char *escaped = malloc(ecap);
  if (escaped == NULL) die("out of memory");
  js_escape_single(escaped, ecap, json);

  size_t need = strlen(escaped) + 64;
  eval_job *job = malloc(sizeof *job);
  if (job == NULL) die("out of memory");
  job->script = malloc(need);
  if (job->script == NULL) die("out of memory");

  snprintf(job->script, need, "window.rpc._reply(%lld,'%s')", (long long)id, escaped);
  free(escaped);

  if (webview_dispatch(g_window, eval_on_main, job) != 0) {
    free(job->script);
    free(job);
    die("could not queue a reply for the page");
  }
}

static void on_rpc(const char *seq, const char *req, void *arg) {
  (void)arg;

  /* Settle webview's own promise for this call; the real reply goes via _reply. */
  webview_return(g_window, seq, 0, "null");

  /* req is the JSON argument array, e.g. [{"id":1,"method":...}]. */
  int64_t id = 0;
  if (!json_int(req, "id", &id)) {
    fprintf(stderr, "text-edit: rpc request without id: %.200s\n", req);
    return;
  }

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
  load_bodies();

  g_window = webview_create(getenv("TEXT_EDIT_DEBUG") != NULL, NULL);
  if (g_window == NULL) {
    die("could not create the window (webview_create returned null)");
  }

  /* A non-null webview does not prove a native window appeared. */
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
