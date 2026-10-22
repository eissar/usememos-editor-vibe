export function panic(reason: string): never {
  report(reason);
  throw new Error(reason);
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
    report(message(error));
  });
}

function report(reason: string): void {
  console.error(reason);
  const status = document.querySelector("#status");
  if (status !== null) {
    status.textContent = `error: ${reason}`;
    return;
  }
  render_failure(reason);
}

function render_failure(reason: string): void {
  const host = document.body ?? document.documentElement;
  if (host === null) return;

  const box = document.createElement("pre");
  box.id = "fatal";
  box.textContent = `text-edit failed to start:\n\n${reason}`;
  box.style.cssText =
    "position:fixed;inset:0;margin:0;padding:16px;z-index:2147483647;" +
    "background:#16181d;color:#e06c75;font:13px/1.5 ui-monospace,monospace;" +
    "white-space:pre-wrap;overflow:auto";
  host.append(box);
}

window.addEventListener("error", (event) => {
  report(message(event.error ?? event.message));
});

window.addEventListener("unhandledrejection", (event) => {
  report(message(event.reason));
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
