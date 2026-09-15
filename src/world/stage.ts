// The authored half of a scroll stage (#30): a script of formations, placed by
// distance along the stage, read by a cursor as the window climbs past them.
//
// Nothing here rolls dice. A stage is the same every run — that is what makes
// it learnable, and learnable is the whole reason a shmup stage is authored
// rather than generated. The trickle in scroll.ts stays as the fallback for a
// run with no script (see scrollStep).

import { placeShip } from "./factory";
import { activeTeams } from "./tuning";
import {
  ARENA,
  type FormationShape,
  type LightCycle,
  type StageEntry,
  type World,
} from "./types";

/** Spacing between neighbouring ships in a formation, in cells. */
const FORMATION_GAP = 22;

/** How far beyond the leading edge a formation forms up, in cells. */
const FORM_AHEAD = 40;

/**
 * Where ship `i` of `count` sits relative to the formation's centre. Forward is
 * -y, so a positive dy is *behind* the formation's nose: a vee trails its
 * wings, a column strings out astern.
 */
const formationOffset = (
  shape: FormationShape,
  i: number,
  count: number,
): [number, number] => {
  const off = i - (count - 1) / 2;
  switch (shape) {
    case "line":
      return [off * FORMATION_GAP, 0];
    case "vee":
      return [off * FORMATION_GAP, Math.abs(off) * FORMATION_GAP];
    case "column":
      return [0, i * FORMATION_GAP];
    case "echelon":
      return [off * FORMATION_GAP, off * FORMATION_GAP];
  }
};

/** Cells of stage flown so far. Forward is -y, so travel is a falling scrollY. */
export const stageTravelled = (world: World): number => -world.scrollY;

// Build one formation's ships. They enter nose-down (+y) — pointed at the
// pilot, who is flying up-stage at them — and are clamped inside the field
// width so a wide formation authored near an edge doesn't muster off-screen.
const formationShips = (
  world: World,
  entry: StageEntry,
  firstId: number,
): LightCycle[] => {
  const teams = activeTeams(world.config);
  const name = entry.team ?? world.config.run?.enemyTeams[0];
  const team = teams.find((t) => t.name === name) ?? teams[teams.length - 1];
  const ships: LightCycle[] = [];
  for (let i = 0; i < entry.count; i++) {
    const [ox, oy] = formationOffset(entry.shape, i, entry.count);
    const x = Math.min(ARENA.w - 8, Math.max(8, entry.x + ox));
    const y = world.scrollY - FORM_AHEAD + oy;
    const ship = placeShip(
      firstId + i,
      x,
      y,
      entry.level,
      entry.hull,
      team,
      [0, 1],
    );
    ships.push(entry.emitter ? { ...ship, emitter: entry.emitter } : ship);
  }
  return ships;
};

/**
 * Enter every formation the stage has now reached. Runs after the tick has
 * committed, so the ships it adds fly for the first time on the next one — the
 * same deal the wave director and the trickle get.
 */
export const stageStep = (world: World): World => {
  const script = world.config.run?.stage;
  if (!script || world.config.format !== "scroll") return world;
  if (world.scrollHalted || world.run?.over) return world;

  const travelled = stageTravelled(world);
  let cursor = world.stageCursor;
  let nextId = world.ships.nextId;
  const items = [...world.ships.items];
  while (cursor < script.entries.length) {
    const entry = script.entries[cursor];
    if (entry.at > travelled) break;
    items.push(...formationShips(world, entry, nextId));
    nextId += entry.count;
    cursor += 1;
  }
  if (cursor === world.stageCursor) return world;
  return { ...world, stageCursor: cursor, ships: { items, nextId } };
};
