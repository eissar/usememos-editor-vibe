/**
 * Arithmetic shared by every host build.
 *
 * Deltas arrive from the frontend as a batch of (from, to, insert) triples that
 * all address the ORIGINAL document. The host owns the text; this module only
 * decides whether a batch is applicable and what length it produces, which is
 * the part worth compiling.
 *
 * Every export is scalar-in, scalar-out: the ABI cannot carry pointers across
 * hosts, and every i64 return is masked so its range is provable.
 */

const MASK = 0xffffffff;

export const OK = 0;
export const ERR_DOC = 1;
export const ERR_RANGE = 2;
export const ERR_DRIFT = 3;

interface Hit {
  readonly from: number;
  readonly to: number;
  readonly insertLen: number;
}

interface HitList {
  items: Hit[];
}

const tables = new Map<number, HitList>();

function whole(n: number): number {
  return Math.floor(n) & MASK;
}

/** Ascending by `from`. Batches are small (per-keystroke until coalesced). */
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

function listFor(ctx: number): HitList {
  const found = tables.get(ctx);
  if (found !== undefined) return found;
  const fresh: HitList = { items: [] };
  tables.set(ctx, fresh);
  return fresh;
}

/** Register a slot. `ctx` is the host's handle for one document. */
export function ctxOpen(ctx: number): number {
  tables.set(ctx, { items: [] });
  return Math.floor(tables.size) & MASK;
}

export function ctxClose(ctx: number): number {
  return Math.floor(tables.delete(ctx) ? 1 : 0) & MASK;
}

export function ctxCount(): number {
  return Math.floor(tables.size) & MASK;
}

/** Queue one range. Rejects inverted ranges outright. */
export function push(ctx: number, from: number, to: number, insertLen: number): number {
  if (from > to) return Math.floor(ERR_RANGE) & MASK;
  const list = listFor(ctx);
  list.items.push({ from: whole(from), to: whole(to), insertLen: whole(insertLen) });
  return 0;
}

export function clear(ctx: number): number {
  listFor(ctx).items = [];
  return 0;
}

/**
 * Apply a batch to `baseLen` and report the resulting length.
 *
 * Returns MASK when the batch is not applicable (overlap or inversion), which
 * callers treat as a hard reject: a partially applied batch would corrupt the
 * document.
 */
function apply(ctx: number, baseLen: number): number {
  const found = tables.get(ctx);
  if (found === undefined) return Math.floor(MASK) & MASK;

  const items = ordered(found.items);
  let length = whole(baseLen);
  let last = 0;

  for (const hit of items) {
    if (hit.from < last) return Math.floor(MASK) & MASK;
    if (hit.to < hit.from) return Math.floor(MASK) & MASK;
    length = whole(length - (hit.to - hit.from) + hit.insertLen);
    last = hit.to;
  }

  return length < 0 ? 0 : Math.floor(length) & MASK;
}

/**
 * Validate that the batch yields exactly `expected`. Distinguishing drift from
 * a range violation matters: drift is a stale batch, a range error is a
 * frontend bug.
 */
export function validate(ctx: number, baseLen: number, expected: number): number {
  const found = tables.get(ctx);
  if (found === undefined) return Math.floor(ERR_DOC) & MASK;

  const items = ordered(found.items);
  let last = 0;
  for (const hit of items) {
    if (hit.to < hit.from) return Math.floor(ERR_RANGE) & MASK;
    if (hit.from < last) return Math.floor(ERR_RANGE) & MASK;
    last = hit.to;
  }

  const predicted = apply(ctx, baseLen);
  if (predicted === MASK) return Math.floor(ERR_RANGE) & MASK;
  return Math.floor(predicted === whole(expected) ? 0 : ERR_DRIFT) & MASK;
}

