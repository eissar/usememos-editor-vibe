/*
 * Client for the Memos (usememos) REST API.
 *
 * Every call returns a Result: network failures, timeouts and non-2xx replies
 * are expected outcomes of talking to a server, so they come back as values
 * rather than throws. `fetch` is injected so the client runs anywhere (page,
 * Bun, tests) and can be exercised without a server.
 *
 * Paths are relative to `apiPrefix`: "/api/v1" for Memos 0.30-0.31, "/api"
 * for later releases (which answer the old prefix with 410 Gone).
 */

export interface MemosConfig {
  baseUrl: string;
  token: string;
  apiPrefix?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export type Visibility = "PRIVATE" | "PROTECTED" | "PUBLIC";
export type MemoState = "NORMAL" | "ARCHIVED";

export interface Memo {
  /* "memos/{id}" */
  name: string;
  content: string;
  visibility?: Visibility;
  state?: MemoState;
  createTime?: string;
  updateTime?: string;
}

export interface User {
  /* "users/{id}" */
  name: string;
}

export type MemosError =
  | { kind: "network"; message: string }
  | { kind: "timeout" }
  | { kind: "http"; status: number; body: string }
  | { kind: "malformed"; message: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: MemosError };

export interface ListOptions {
  /* "users/{id}"; defaults to the authenticated user. */
  parent?: string;
  state?: MemoState;
  pageSize?: number;
  /* AIP-160 filter, e.g. 'tag in ["projects"]'. */
  filter?: string;
}

export interface MemoPage {
  memos: Memo[];
  /* Empty on the last page. */
  nextPageToken: string;
}

const DEFAULT_PREFIX = "/api/v1";
const DEFAULT_TIMEOUT_MS = 15_000;

/* "memos/abc" -> "abc" */
export function memoId(memo: Pick<Memo, "name">): string {
  const slash = memo.name.lastIndexOf("/");
  return slash < 0 ? memo.name : memo.name.slice(slash + 1);
}

export function describeError(error: MemosError): string {
  switch (error.kind) {
    case "network":
      return `network: ${error.message}`;
    case "timeout":
      return "timed out";
    case "http":
      return `HTTP ${error.status}${error.body ? `: ${error.body.slice(0, 200)}` : ""}`;
    case "malformed":
      return `malformed reply: ${error.message}`;
  }
}

function isMemo(value: unknown): value is Memo {
  const v = value as Partial<Memo> | null;
  return typeof v?.name === "string" && typeof v.content === "string";
}

export class MemosClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private user: User | null = null;

  constructor(config: MemosConfig) {
    this.base = config.baseUrl.replace(/\/+$/, "") + (config.apiPrefix ?? DEFAULT_PREFIX);
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Wrapped, not stored: browsers reject a bare `fetch` called as a method
    // of another object ("Illegal invocation").
    this.fetchFn = config.fetch ?? ((input, init) => fetch(input, init));
  }

  /* GET auth/me; cached after the first success. */
  async me(): Promise<Result<User>> {
    if (this.user !== null) return { ok: true, value: this.user };
    const reply = await this.request("GET", "/auth/me");
    if (!reply.ok) return reply;
    const user = (reply.value as { user?: Partial<User> } | null)?.user;
    if (typeof user?.name !== "string") return malformed("auth/me has no user name");
    this.user = { name: user.name };
    return { ok: true, value: this.user };
  }

  /* GET memos, one page. Pass the previous page's nextPageToken to continue. */
  async listMemosPage(options: ListOptions = {}, pageToken = ""): Promise<Result<MemoPage>> {
    let parent = options.parent;
    if (parent === undefined) {
      const user = await this.me();
      if (!user.ok) return user;
      parent = user.value.name;
    }

    const query = new URLSearchParams({
      parent,
      state: options.state ?? "NORMAL",
      pageSize: String(options.pageSize ?? 100),
    });
    if (options.filter !== undefined) query.set("filter", options.filter);
    if (pageToken) query.set("pageToken", pageToken);

    const reply = await this.request("GET", `/memos?${query}`);
    if (!reply.ok) return reply;
    const page = reply.value as { memos?: unknown; nextPageToken?: unknown } | null;
    const items = page?.memos ?? [];
    if (!Array.isArray(items) || !items.every(isMemo)) return malformed("memos list");
    const next = typeof page?.nextPageToken === "string" ? page.nextPageToken : "";
    return { ok: true, value: { memos: items, nextPageToken: next } };
  }

  /* GET memos, following nextPageToken until the last page. */
  async listMemos(options: ListOptions = {}): Promise<Result<Memo[]>> {
    const memos: Memo[] = [];
    let pageToken = "";
    do {
      const page = await this.listMemosPage(options, pageToken);
      if (!page.ok) return page;
      memos.push(...page.value.memos);
      pageToken = page.value.nextPageToken;
    } while (pageToken);
    return { ok: true, value: memos };
  }

  /* GET memos/{id} */
  async getMemo(id: string): Promise<Result<Memo>> {
    return this.memoReply(await this.request("GET", `/memos/${encodeURIComponent(id)}`));
  }

  /* POST memos. `id` asks the server to use that id instead of generating one. */
  async createMemo(
    content: string,
    options: { id?: string; visibility?: Visibility } = {},
  ): Promise<Result<Memo>> {
    const query = options.id === undefined ? "" : `?memoId=${encodeURIComponent(options.id)}`;
    const body = { content, visibility: options.visibility ?? "PRIVATE" };
    return this.memoReply(await this.request("POST", `/memos${query}`, body));
  }

  /* PATCH memos/{id} with updateMask=content. */
  async updateContent(id: string, content: string): Promise<Result<Memo>> {
    const name = `memos/${id}`;
    const path = `/memos/${encodeURIComponent(id)}?updateMask=content`;
    return this.memoReply(await this.request("PATCH", path, { name, content }));
  }

  /* DELETE memos/{id} */
  async deleteMemo(id: string): Promise<Result<void>> {
    const reply = await this.request("DELETE", `/memos/${encodeURIComponent(id)}`);
    return reply.ok ? { ok: true, value: undefined } : reply;
  }

  private memoReply(reply: Result<unknown>): Result<Memo> {
    if (!reply.ok) return reply;
    return isMemo(reply.value) ? { ok: true, value: reply.value } : malformed("memo");
  }

  private async request(method: string, path: string, body?: unknown): Promise<Result<unknown>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchFn(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return { ok: false, error: { kind: "timeout" } };
      }
      return { ok: false, error: { kind: "network", message: String(error) } };
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) return { ok: false, error: { kind: "http", status: response.status, body: text } };
    if (text === "") return { ok: true, value: null };
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return malformed(`${method} ${path}: not JSON`);
    }
  }
}

function malformed(message: string): { ok: false; error: MemosError } {
  return { ok: false, error: { kind: "malformed", message } };
}
