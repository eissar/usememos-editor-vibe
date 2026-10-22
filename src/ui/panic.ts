export function panic(reason: string): never {
  throw new Error(reason);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false };

export function parseJson(raw: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export function run<A extends unknown[]>(fn: (...args: A) => unknown, ...args: A): void {
  void Promise.resolve(fn(...args)).catch((error: unknown) => panic(message(error)));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
