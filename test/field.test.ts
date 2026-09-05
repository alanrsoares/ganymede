// The field seam (src/world/field.ts): ARENA is a derived cache with exactly
// one writer. These lock the two properties the scroll topology (#27) will
// build on — the tick always re-derives the field, and today's derivation is
// the toroidal arena the game already ships.

import { afterEach, expect, test } from "bun:test";
import type { Seed } from "~/engine/rng";
import {
  ARENA,
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  initWorld,
  setGridBounds,
  syncField,
  update,
} from "~/world";

afterEach(() => setGridBounds(DEFAULT_GRID_W, DEFAULT_GRID_H));

const world = () => initWorld(1234 as Seed);

test("the standing topology is an all-range torus at the origin", () => {
  syncField(world());
  expect(ARENA).toMatchObject({
    x0: 0,
    y0: 0,
    w: DEFAULT_GRID_W,
    h: DEFAULT_GRID_H,
    wrapX: true,
    wrapY: true,
  });
});

test("a resize is picked up, and survives re-derivation", () => {
  setGridBounds(630, 270);
  expect(ARENA).toMatchObject({ w: 630, h: 270 });
  syncField(world());
  expect(ARENA).toMatchObject({ w: 630, h: 270, x0: 0, y0: 0 });
});

test("syncField is idempotent", () => {
  const w = world();
  syncField(w);
  const first = { ...ARENA };
  syncField(w);
  syncField(w);
  expect({ ...ARENA }).toEqual(first);
});

test("a tick re-derives the field, so stray writes cannot stick", () => {
  setGridBounds(480, 270);
  // Someone reaches past the seam and corrupts the cache.
  ARENA.x0 = 999;
  ARENA.wrapY = false;
  ARENA.w = 7;

  update({ kind: "tick", steps: 1, now: 0 }, world());

  expect(ARENA).toMatchObject({ x0: 0, w: 480, wrapY: true });
});
