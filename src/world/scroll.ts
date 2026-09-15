// Scroll-stage motion: the one scalar the shmup half of the game runs on.
//
// `World.scrollY` is where the camera window's top edge sits along the stage.
// The tick advances it; #28's camera and the field origin both read it; the
// flip beat (#31) freezes it. The stage is a tall coordinate space (fixed
// SCROLL_FIELD_W wide, `stageLength` long) and the window slides up it, so a
// ship flying "forward" is flying toward larger y forever as far as it can
// tell — the stage ends before the wrap at stage length is ever reached.

import { nextInt, nextRange } from "~/engine/rng";
import { rollShip } from "./factory";
import { activeTeams, MAX_ENEMY_SHIPS, SPAWN_INVULN_GENS } from "./tuning";
import { ARENA, type FlipState, type World } from "./types";

/**
 * Playfield width for a scroll stage, in cells — fixed, not derived from the
 * canvas aspect like the all-range arena. Formations are authored at absolute
 * x (#30), so an ultrawide window must get gutter, not a wider world. It is
 * DEFAULT_GRID_W on purpose: the flip's arena is then exactly today's game.
 */
export const SCROLL_FIELD_W = 480;

/**
 * Cells of stage travelled per generation. Forward is -y: the window climbs
 * toward smaller y, so anything at a fixed world position drifts down the
 * screen and the pilot reads as flying up-stage. Everything ahead is therefore
 * at smaller y than the window, and the wake it leaves is at larger y.
 *
 * Playtested down from 0.6: at that rate a formation crossed the window before
 * it was worth engaging, and a drop it left behind was out of the wake before
 * the pilot could turn back for it. Distances in a stage script are in cells,
 * so this changes how long each beat is on screen, not how the stage is spaced.
 */
export const SCROLL_RATE = 0.4;

/**
 * Generations the corridor spends braking into a beat, and getting back up to
 * rate afterwards. The stop is the punctuation the flip is owed (#31): the
 * topology swap itself is instant, but a cut from full scroll straight into a
 * torus reads as a dropped frame rather than a gear change. Roughly half a
 * second each at the default tempo — long enough to feel deliberate, short
 * enough that the pilot is never waiting on it.
 */
export const FLIP_HALT_GENS = 36;
export const FLIP_RESUME_GENS = 30;

/** Ease in and out rather than ramp: a linear brake still lands with a corner. */
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * Fraction of full scroll rate the stage runs at this tick. 1 in the corridor,
 * 0 in the fight, and easing between the two across the beat's outer phases.
 */
export const scrollFactor = (flip: FlipState | null): number => {
  if (!flip) return 1;
  switch (flip.phase) {
    case "fight":
      return 0;
    case "halt":
      return 1 - smoothstep(Math.min(1, flip.gens / FLIP_HALT_GENS));
    case "resume":
      return smoothstep(Math.min(1, flip.gens / FLIP_RESUME_GENS));
  }
};

/**
 * Cells of stage the window climbs per generation, right now. The one answer
 * to "how fast is the world moving" — the camera follows the field origin, and
 * a directly-driven hull cancels this to hold still on screen (motion.ts), so
 * both have to read the same number or the stop drags the pilot with it.
 */
export const scrollSpeed = (world: Pick<World, "config" | "flip">): number =>
  world.config.format !== "scroll" ? 0 : SCROLL_RATE * scrollFactor(world.flip);

/**
 * Advance the stage. A beat in its fight phase holds position, the phases
 * either side of it move at part rate, and anything that is not a scroll stage
 * has nowhere to advance to.
 */
export const advanceScroll = (world: World, steps: number): World =>
  world.config.format !== "scroll"
    ? world
    : { ...world, scrollY: world.scrollY - scrollSpeed(world) * steps };

// --- enemies ----------------------------------------------------------------
// Fallback opposition for a scroll run with no script attached. A stage has no
// bases to muster from, so enemies are rolled in ahead of the window — above
// the top edge, since forward is -y — and fly down into view under the normal
// AI. It is a trickle, not a design: a run that carries a stage script (#30)
// takes its enemies from there instead and never reaches this.

/** Generations between trickle spawns. */
export const SCROLL_SPAWN_GENS = 90;

/** How far beyond the leading edge enemies appear, in cells. */
const SPAWN_AHEAD = 40;

/** True when this tick crossed a spawn boundary (age has already advanced). */
const crossedSpawnBeat = (age: number, steps: number): boolean =>
  Math.floor(age / SCROLL_SPAWN_GENS) >
  Math.floor((age - steps) / SCROLL_SPAWN_GENS);

export const scrollStep = (world: World, steps: number): World => {
  const cfg = world.config.run;
  if (world.config.format !== "scroll" || world.flip) return world;
  if (!cfg || world.run?.over || cfg.stage) return world;
  if (!crossedSpawnBeat(world.age, steps)) return world;

  const enemies = world.ships.items.filter(
    (s) => s.colorName !== cfg.playerTeam,
  ).length;
  if (enemies >= MAX_ENEMY_SHIPS) return world;

  const [count, s0] = nextInt(world.seed, 2); // 1..2 per beat
  let seed = s0;
  let nextId = world.ships.nextId;
  const items = [...world.ships.items];
  for (let i = 0; i <= count; i++) {
    const [x, s1] = nextRange(seed, ARENA.x0 + 40, ARENA.x0 + ARENA.w - 40);
    const [lvlF, s2] = nextRange(s1, 1, 2.999);
    const team = cfg.enemyTeams[i % cfg.enemyTeams.length];
    const [ship, s3] = rollShip(
      s2,
      nextId,
      x,
      ARENA.y0 - SPAWN_AHEAD,
      Math.floor(lvlF),
      team,
      undefined,
      activeTeams(world.config),
    );
    items.push({ ...ship, invulnTime: SPAWN_INVULN_GENS });
    nextId += 1;
    seed = s3;
  }
  return { ...world, seed, ships: { items, nextId } };
};
