// Pure, immutable entity list (Elm-style). Carries a monotonic id counter so
// spawns get stable ids without a mutable closure. Every operation returns a
// new list; nothing is mutated in place. Ships, bursts, and any future entity
// reuse this instead of hand-rolling arrays + id counters.

export interface Entity {
  readonly id: number;
}

/** Strip `readonly` off every field — a mutable view of an immutable entity,
 * used by the tick's in-place scratch pass before it re-freezes the world. */
export type Mutable<T> = { -readonly [P in keyof T]: T[P] };

export interface EntityList<T extends Entity> {
  readonly items: readonly T[];
  readonly nextId: number;
}

export const empty = <T extends Entity>(): EntityList<T> => ({
  items: [],
  nextId: 1,
});

/** Append one entity built from the next id. */
export const spawn = <T extends Entity>(
  list: EntityList<T>,
  make: (id: number) => T,
): EntityList<T> => ({
  items: [...list.items, make(list.nextId)],
  nextId: list.nextId + 1,
});

/** Keep only entities matching `keep`. */
export const retain = <T extends Entity>(
  list: EntityList<T>,
  keep: (item: T) => boolean,
): EntityList<T> =>
  list.items.every(keep) ? list : { ...list, items: list.items.filter(keep) };

/** Trim to at most `n` entities, dropping the oldest on overflow. */
export const cap = <T extends Entity>(
  list: EntityList<T>,
  n: number,
): EntityList<T> =>
  list.items.length <= n
    ? list
    : { ...list, items: list.items.slice(list.items.length - n) };

/**
 * Trim to at most `n`, dropping the oldest *un*protected entities on overflow —
 * protected ones are never dropped, even if that means keeping more than `n`
 * (they're load-bearing: e.g. the arcade pilot + its summons, which a plain
 * `cap` could silently evict and read as a death). With a predicate that never
 * matches this is byte-identical to `cap`.
 */
export const capExcept = <T extends Entity>(
  list: EntityList<T>,
  n: number,
  protect: (item: T) => boolean,
): EntityList<T> => {
  if (list.items.length <= n) return list;
  const protectedCount = list.items.reduce(
    (c, it) => c + (protect(it) ? 1 : 0),
    0,
  );
  // How many unprotected must go to fit the budget left after protected ships.
  let toDrop =
    list.items.length - protectedCount - Math.max(0, n - protectedCount);
  if (toDrop <= 0) return list;
  // Drop the first `toDrop` unprotected (oldest), keep protected + newest rest.
  const items = list.items.filter((it) => {
    if (toDrop > 0 && !protect(it)) {
      toDrop--;
      return false;
    }
    return true;
  });
  return { ...list, items };
};
