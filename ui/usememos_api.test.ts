import { describe, expect, test } from "bun:test";
import { MemosClient, describeError, memoId } from "./usememos_api.ts";

interface Seen {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/* A fetch that records requests and answers from a route table. */
function fakeFetch(routes: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const req: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      auth: headers.get("Authorization"),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    seen.push(req);
    return routes(req);
  }) as typeof fetch;
  return { fn, seen };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

const client = (fn: typeof fetch, extra: object = {}) =>
  new MemosClient({ baseUrl: "http://memos.test/", token: "tok", fetch: fn, ...extra });

describe("MemosClient", () => {
  test("me resolves the user and sends the bearer token", async () => {
    const { fn, seen } = fakeFetch(() => json({ user: { name: "users/1" } }));
    const r = await client(fn).me();
    expect(r).toEqual({ ok: true, value: { name: "users/1" } });
    expect(seen[0]!.url).toBe("http://memos.test/api/v1/auth/me");
    expect(seen[0]!.auth).toBe("Bearer tok");
  });

  test("apiPrefix selects the newer /api routes", async () => {
    const { fn, seen } = fakeFetch(() => json({ user: { name: "users/1" } }));
    await client(fn, { apiPrefix: "/api" }).me();
    expect(seen[0]!.url).toBe("http://memos.test/api/auth/me");
  });

  test("listMemos follows page tokens and defaults parent to the current user", async () => {
    const { fn, seen } = fakeFetch((req) => {
      if (req.url.endsWith("/auth/me")) return json({ user: { name: "users/7" } });
      const token = new URL(req.url).searchParams.get("pageToken");
      if (!token) return json({ memos: [{ name: "memos/a", content: "A" }], nextPageToken: "p2" });
      return json({ memos: [{ name: "memos/b", content: "B" }] });
    });
    const r = await client(fn).listMemos({ filter: 'tag in ["x"]' });
    expect(r.ok && r.value.map(memoId)).toEqual(["a", "b"]);

    const first = new URL(seen[1]!.url);
    expect(first.pathname).toBe("/api/v1/memos");
    expect(first.searchParams.get("parent")).toBe("users/7");
    expect(first.searchParams.get("state")).toBe("NORMAL");
    expect(first.searchParams.get("filter")).toBe('tag in ["x"]');
    expect(new URL(seen[2]!.url).searchParams.get("pageToken")).toBe("p2");
  });

  test("listMemosPage returns one page and its token; me is fetched once", async () => {
    const { fn, seen } = fakeFetch((req) => {
      if (req.url.endsWith("/auth/me")) return json({ user: { name: "users/7" } });
      return json({ memos: [{ name: "memos/a", content: "A" }], nextPageToken: "p2" });
    });
    const c = client(fn);
    const first = await c.listMemosPage({ pageSize: 20 });
    expect(first).toEqual({ ok: true, value: { memos: [{ name: "memos/a", content: "A" }], nextPageToken: "p2" } });
    await c.listMemosPage({ pageSize: 20 }, "p2");
    expect(seen.filter((r) => r.url.endsWith("/auth/me")).length).toBe(1);
    const second = new URL(seen.at(-1)!.url);
    expect(second.searchParams.get("pageSize")).toBe("20");
    expect(second.searchParams.get("pageToken")).toBe("p2");
  });

  test("createMemo posts content and passes a requested id as memoId", async () => {
    const { fn, seen } = fakeFetch((req) => json({ name: "memos/local-abc", content: (req.body as { content: string }).content }));
    const r = await client(fn).createMemo("hello", { id: "local-abc" });
    expect(r.ok && memoId(r.value)).toBe("local-abc");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("http://memos.test/api/v1/memos?memoId=local-abc");
    expect(seen[0]!.body).toEqual({ content: "hello", visibility: "PRIVATE" });
  });

  test("updateContent patches only content", async () => {
    const { fn, seen } = fakeFetch(() => json({ name: "memos/a", content: "new" }));
    const r = await client(fn).updateContent("a", "new");
    expect(r.ok).toBe(true);
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.url).toBe("http://memos.test/api/v1/memos/a?updateMask=content");
    expect(seen[0]!.body).toEqual({ name: "memos/a", content: "new" });
  });

  test("deleteMemo accepts an empty reply", async () => {
    const { fn, seen } = fakeFetch(() => new Response("", { status: 200 }));
    expect(await client(fn).deleteMemo("a")).toEqual({ ok: true, value: undefined });
    expect(seen[0]!.method).toBe("DELETE");
  });

  test("failures are values, not throws", async () => {
    const http = await client(fakeFetch(() => new Response("gone", { status: 410 })).fn).getMemo("a");
    expect(http).toEqual({ ok: false, error: { kind: "http", status: 410, body: "gone" } });

    const network = await client(
      fakeFetch(() => {
        throw new TypeError("connection refused");
      }).fn,
    ).getMemo("a");
    expect(network.ok === false && network.error.kind).toBe("network");

    const shape = await client(fakeFetch(() => json({ nope: 1 })).fn).getMemo("a");
    expect(shape.ok === false && shape.error.kind).toBe("malformed");

    const notJson = await client(fakeFetch(() => new Response("<html>", { status: 200 })).fn).getMemo("a");
    expect(notJson.ok === false && notJson.error.kind).toBe("malformed");
  });

  test("the default fetch is called with globalThis as its receiver", async () => {
    const original = globalThis.fetch;
    let receiver: unknown = null;
    globalThis.fetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve(json({ user: { name: "users/1" } }));
    } as typeof fetch;
    try {
      await new MemosClient({ baseUrl: "http://memos.test", token: "t" }).me();
    } finally {
      globalThis.fetch = original;
    }
    expect(receiver === undefined || receiver === globalThis).toBe(true);
  });

  test("a slow server times out", async () => {
    const slow = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const r = await client(slow, { timeoutMs: 20 }).getMemo("a");
    expect(r).toEqual({ ok: false, error: { kind: "timeout" } });
    expect(describeError({ kind: "timeout" })).toBe("timed out");
  });
});
