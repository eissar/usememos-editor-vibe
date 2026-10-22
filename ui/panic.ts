export function panic(reason: string): never {
  const host = document.body ?? document.documentElement;
  if (host !== null) {
    const panel = document.createElement("pre");
    panel.textContent = `text-edit: ${reason}`;
    panel.style.cssText =
      "position:fixed;inset:0;margin:0;padding:16px;z-index:2147483647;" +
      "background:#16181d;color:#e06c75;font:13px/1.5 ui-monospace,monospace;" +
      "white-space:pre-wrap;overflow:auto";
    host.replaceChildren(panel);
  }
  throw new Error(reason);
}

export function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) panic(reason);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false };

export function parseJson(raw: string): Parsed<unknown> {
  if (typeof raw !== "string") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export function parseReplyObject(raw: string): Parsed<Record<string, unknown>> {
  const parsed = parseJson(raw);
  if (!parsed.ok) return { ok: false };
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

export function run<A extends unknown[]>(fn: (...args: A) => unknown, ...args: A): void {
  void Promise.resolve(fn(...args)).catch((error: unknown) => {
    panic(describe(error));
  });
}

/* Everything a throw can carry, rendered readably. A binding that rejects with
 * a structured value otherwise surfaces as "[object Object]", which says
 * nothing about what failed. */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.stack !== undefined && error.stack !== "" ? error.stack : error.message;
  }
  if (error === null) return "null";
  if (error === undefined) return "undefined";

  if (typeof error === "object") {
    try {
      const text = JSON.stringify(error);
      if (text !== undefined && text !== "{}") return text;
    } catch {
      // circular or otherwise unserialisable; fall through to a key dump
    }
    try {
      return Object.prototype.toString.call(error) + " " + Object.keys(error).join(",");
    } catch {
      return "unprintable object";
    }
  }

  return String(error);
}
