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
import { ARENA, type World } from "./types";

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
 */
export const SCROLL_RATE = 0.6;

/**
 * Advance the stage. A halted scroll (the flip beat) holds its position, and
 * anything that is not a scroll stage has nowhere to advance to.
 */
export const advanceScroll = (world: World, steps: number): World =>
  world.config.format !== "scroll" || world.scrollHalted
    ? world
    : { ...world, scrollY: world.scrollY - SCROLL_RATE * steps };

// --- enemies ----------------------------------------------------------------
// Placeholder opposition until the formation script lands (#30). A stage has no
// bases to muster from, so enemies are rolled in ahead of the window — above
// the top edge, since forward is -y — and fly down into view under the normal
// AI. It is a trickle, not a design: authored formations are the whole point of
// #30, and this exists so the stage is not an empty corridor before then.

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
  if (world.config.format !== "scroll" || world.scrollHalted) return world;
  if (!cfg || world.run?.over) return world;
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
