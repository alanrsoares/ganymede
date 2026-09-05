// The single writer of ARENA. Every other module reads the field; only this
// one rewrites it, so "where did the playfield change?" has one answer.
//
// The field is a derived cache: `syncField` runs at the top of every tick and
// recomputes it from the inputs below. Today those inputs are just the canvas
// aspect (via `setGridBounds`) and the standing all-range topology — origin at
// 0,0, both axes toroidal, which is the game as it ships. The scroll topology
// (#27) moves y0 along the stage and drops wrapY; which mode is in play is
// #22's question, which is why syncField already takes the World it will read.

import { ARENA, DEFAULT_GRID_H, DEFAULT_GRID_W, type World } from "./types";

// Requested extent, set by the resize edge. Kept apart from ARENA itself so a
// resize can never leave the field half-written mid-tick.
let requestedW = DEFAULT_GRID_W;
let requestedH = DEFAULT_GRID_H;

const applyField = () => {
  ARENA.x0 = 0;
  ARENA.y0 = 0;
  ARENA.w = requestedW;
  ARENA.h = requestedH;
  ARENA.wrapX = true;
  ARENA.wrapY = true;
};

/**
 * Recompute the field for this tick. Takes the World because the scroll/torus
 * choice is a property of the run, not of the canvas — it reads nothing from it
 * until #22 settles where mode lives.
 */
export const syncField = (_world: World): void => applyField();

/** Re-derive the field extent from the canvas aspect (the resize edge). */
export const setGridBounds = (w: number, h: number): void => {
  requestedW = w;
  requestedH = h;
  applyField();
};
