// The single writer of ARENA. Every other module reads the field; only this
// one rewrites it, so "where did the playfield change?" has one answer.
//
// The field is a derived cache: `syncField` runs at the top of every tick and
// recomputes it from the World. Two topologies exist:
//
//   all-range — origin 0,0, both axes toroidal, extent from the canvas aspect.
//               Autobattle and arcade. This is the game as it has always been.
//   scroll    — a fixed-width window sliding along a tall stage: origin at the
//               live scroll position, both axes open. Nothing wraps, so a ship
//               flying forward keeps flying forward.
//
// The flip beat (#31) halts the scroll and turns both wrap flags back on. That
// makes the field 480x270 at origin (0, scrollY) with both axes toroidal —
// which is exactly today's arena, one stage-length up the y axis. No entity
// coordinate moves across the flip; only these six numbers change.

import { SCROLL_FIELD_W } from "./scroll";
import {
  ARENA,
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  type MatchConfig,
  type World,
} from "./types";

/** Everything `syncField` reads. Narrow so a world under construction — one
 * that has a config but no entities yet — can derive the field it rolls its
 * scenery onto (see init.ts). */
export type FieldInputs = Pick<World, "config" | "scrollY" | "scrollHalted">;

// Requested extent, set by the resize edge. Kept apart from ARENA itself so a
// resize can never leave the field half-written mid-tick, and so a scroll stage
// can ignore it (its width is fixed; see SCROLL_FIELD_W).
let requestedW = DEFAULT_GRID_W;
let requestedH = DEFAULT_GRID_H;

const allRange = () => {
  ARENA.x0 = 0;
  ARENA.y0 = 0;
  ARENA.w = requestedW;
  ARENA.h = requestedH;
  ARENA.wrapX = true;
  ARENA.wrapY = true;
};

/**
 * Recompute the field for this tick. Reads the format for which topology is in
 * play and the live scroll position for where the window sits — nothing else,
 * so the field is a pure function of the World and a replay reproduces it.
 */
export const syncField = (world: FieldInputs): void => {
  if (world.config.format !== "scroll") {
    allRange();
    return;
  }
  // The window is the field: everything outside it is culled, which is what
  // kills the scroll wake behind the camera and the exits off the sides.
  ARENA.x0 = 0;
  ARENA.y0 = world.scrollY;
  ARENA.w = SCROLL_FIELD_W;
  ARENA.h = DEFAULT_GRID_H;
  // Halted = the flip beat: the arena closes back into a torus in place.
  ARENA.wrapX = world.scrollHalted;
  ARENA.wrapY = world.scrollHalted;
};

/**
 * True while the arena's fixed furniture — team bases, the centre pad, portals,
 * heal pads — is part of the world. It sits at absolute coordinates in the
 * all-range field, so a scroll stage flies past where it would be: it is
 * neither drawn nor collided with there. (What the flip's arena contains is
 * #31's question.)
 */
export const hasArenaFurniture = (world: {
  config: { format: MatchConfig["format"] };
}): boolean => world.config.format !== "scroll";

/** Re-derive the field extent from the canvas aspect (the resize edge). */
export const setGridBounds = (w: number, h: number): void => {
  requestedW = w;
  requestedH = h;
  allRange();
};
