/**
 * Arithmetic shared by every host build.
 *
 * Deltas arrive from the frontend as a batch of (from, to, insert) triples that
 * all address the ORIGINAL document. The host owns the text; this module only
 * decides whether a batch is applicable and what length it produces, which is
 * the part worth compiling.
 *
 * Every export is scalar-in, scalar-out. Inputs are validated before any
 * arithmetic, because `& 0xffffffff` is signed int32 in JS: masking a bad value
 * silently produces a plausible-looking negative instead of a reject.
 */

export const OK = 0;
export const ERR_DOC = 1;
export const ERR_RANGE = 2;
export const ERR_DRIFT = 3;

/** Largest length or offset the ABI can carry without ambiguity. */
const LIMIT = 0x7fffffff;

interface Hit {
  readonly from: number;
  readonly to: number;
  readonly insertLen: number;
}

interface HitList {
  items: Hit[];
}

const tables = new Map<number, HitList>();

function valid(n: number): boolean {
  return n >= 0 && n <= LIMIT;
}

function count(n: number): number {
  return n < 0 ? 0 : Math.floor(n);
}

function ordered(items: Hit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of items) out.push(h);

  for (let i = 1; i < out.length; i++) {
    const cur = out[i]!;
    let j = i - 1;
    while (j >= 0 && out[j]!.from > cur.from) {
      out[j + 1] = out[j]!;
      j--;
    }
    out[j + 1] = cur;
  }
  return out;
}

/**
 * Register a slot and return the handle, which is the context itself. Returning
 * anything else would let a caller address a different document. Re-opening an
 * existing slot is rejected rather than silently discarding its queue.
 */
export function ctxOpen(ctx: number): number {
  if (!valid(ctx)) return ERR_DOC | 0;
  if (tables.has(ctx)) return ERR_DOC | 0;
  tables.set(ctx, { items: [] });
  return ctx | 0;
}

export function ctxClose(ctx: number): number {
  if (!valid(ctx)) return ERR_DOC | 0;
  return (tables.delete(ctx) ? OK : ERR_DOC) | 0;
}

export function ctxCount(): number {
  return tables.size | 0;
}

/**
 * Queue one range. Every argument is validated first: a negative or fractional
 * offset, or a negative insert length, would otherwise mask to a huge value and
 * be accepted.
 */
export function push(ctx: number, from: number, to: number, insertLen: number): number {
  if (!valid(ctx)) return ERR_DOC | 0;
  const found = tables.get(ctx);
  if (found === undefined) return ERR_DOC | 0;
  if (!valid(from) || !valid(to) || !valid(insertLen)) return ERR_RANGE | 0;
  if (from > to) return ERR_RANGE | 0;

  found.items.push({ from, to, insertLen });
  return OK | 0;
}

export function clear(ctx: number): number {
  if (!valid(ctx)) return ERR_DOC | 0;
  const found = tables.get(ctx);
  if (found === undefined) return ERR_DOC | 0;
  found.items = [];
  return OK | 0;
}

/**
 * Apply a batch to `baseLen`. Returns the resulting length, or a negative error
 * code. Overlap, out-of-range offsets and length overflow are all rejects: a
 * partially applied batch would corrupt the document.
 */
function apply(ctx: number, baseLen: number): number {
  const found = tables.get(ctx);
  if (found === undefined) return -ERR_DOC;
  if (!valid(baseLen)) return -ERR_RANGE;

  const items = ordered(found.items);
  let length = baseLen;
  let last = 0;

  for (const hit of items) {
    if (hit.from < last) return -ERR_RANGE;
    if (hit.to < hit.from) return -ERR_RANGE;
    if (hit.to > baseLen) return -ERR_RANGE;

    length = length - (hit.to - hit.from) + hit.insertLen;
    if (!valid(length)) return -ERR_RANGE;
    last = hit.to;
  }

  return length < 0 || length > LIMIT ? -ERR_RANGE : length | 0;
}

/**
 * Validate that the batch yields exactly `expected`. Drift and a range
 * violation stay distinct: drift is a stale batch, a range error is a frontend
 * bug, and the host recovers from them differently.
 */
export function validate(ctx: number, baseLen: number, expected: number): number {
  if (!valid(ctx)) return ERR_DOC | 0;
  if (!valid(baseLen) || !valid(expected)) return ERR_RANGE | 0;

  const predicted = apply(ctx, baseLen);
  if (predicted < 0) return (predicted === -ERR_RANGE ? ERR_RANGE : ERR_DOC) | 0;
  return (predicted === expected ? 0 : ERR_DRIFT) | 0;
}
