export function panic(reason: string): never {
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
  const status = document.querySelector("#status");
  if (status !== null) status.textContent = `error: ${reason}`;
  console.error(reason);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
