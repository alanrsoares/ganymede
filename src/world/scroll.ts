// Scroll-stage motion: the one scalar the shmup half of the game runs on.
//
// `World.scrollY` is where the camera window's top edge sits along the stage.
// The tick advances it; #28's camera and the field origin both read it; the
// flip beat (#31) freezes it. The stage is a tall coordinate space (fixed
// SCROLL_FIELD_W wide, `stageLength` long) and the window slides up it, so a
// ship flying "forward" is flying toward larger y forever as far as it can
// tell — the stage ends before the wrap at stage length is ever reached.

import type { World } from "./types";

/**
 * Playfield width for a scroll stage, in cells — fixed, not derived from the
 * canvas aspect like the all-range arena. Formations are authored at absolute
 * x (#30), so an ultrawide window must get gutter, not a wider world. It is
 * DEFAULT_GRID_W on purpose: the flip's arena is then exactly today's game.
 */
export const SCROLL_FIELD_W = 480;

/** Cells of stage travelled per generation. */
export const SCROLL_RATE = 0.6;

/**
 * Advance the stage. A halted scroll (the flip beat) holds its position, and
 * anything that is not a scroll stage has nowhere to advance to.
 */
export const advanceScroll = (world: World, steps: number): World =>
  world.config.format !== "scroll" || world.scrollHalted
    ? world
    : { ...world, scrollY: world.scrollY + SCROLL_RATE * steps };
