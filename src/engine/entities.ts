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
