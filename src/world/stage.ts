// The authored half of a scroll stage (#30): a script of formations, placed by
// distance along the stage, read by a cursor as the window climbs past them.
//
// Nothing here rolls dice. A stage is the same every run — that is what makes
// it learnable, and learnable is the whole reason a shmup stage is authored
// rather than generated. The trickle in scroll.ts stays as the fallback for a
// run with no script (see scrollStep).

import { placePickup, placeShip } from "./factory";
import { activeTeams } from "./tuning";
import {
  ARENA,
  type FormationShape,
  type FormationSpec,
  type LightCycle,
  type Pickup,
  type StageDrop,
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

/** Margin kept between a formation's outermost ship and the corridor edge. */
const EDGE_MARGIN = 8;

/**
 * Slide the whole formation inside the corridor rather than clamping each ship
 * to the edge: a per-ship clamp stacks the outer ships on one x and throws away
 * the spacing the shape was authored for.
 */
const formationCentre = (spec: FormationSpec, offsets: [number, number][]) => {
  const xs = offsets.map(([ox]) => ox);
  const lo = EDGE_MARGIN - Math.min(...xs);
  const hi = ARENA.w - EDGE_MARGIN - Math.max(...xs);
  // A formation wider than the corridor can't fit; centre it and let the edges
  // spill rather than pinning it to one side.
  if (hi < lo) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, spec.x));
};

/**
 * Build one formation's ships around `noseY`, the y its leading ship sits on.
 * They face nose-down (+y) — pointed at the pilot, who is flying up-stage at
 * them. The corridor forms them up beyond the leading edge; the flip beat (#31)
 * plants them inside the window, which is the only difference between the two.
 */
export const buildFormation = (
  world: World,
  spec: FormationSpec,
  firstId: number,
  noseY: number,
): LightCycle[] => {
  const teams = activeTeams(world.config);
  const name = spec.team ?? world.config.run?.enemyTeams[0];
  const team = teams.find((t) => t.name === name) ?? teams[teams.length - 1];
  const offsets: [number, number][] = [];
  for (let i = 0; i < spec.count; i++)
    offsets.push(formationOffset(spec.shape, i, spec.count));
  const centre = formationCentre(spec, offsets);
  const ships: LightCycle[] = [];
  for (let i = 0; i < spec.count; i++) {
    const [ox, oy] = offsets[i];
    const ship = placeShip(
      firstId + i,
      centre + ox,
      noseY + oy,
      spec.level,
      spec.hull,
      team,
      [0, 1],
    );
    ships.push(spec.emitter ? { ...ship, emitter: spec.emitter } : ship);
  }
  return ships;
};

// Enter every formation the stage has now reached, and open a pending reward
// for each one authored to carry a drop.
const enterFormations = (world: World): World => {
  const script = world.config.run?.stage;
  if (!script) return world;
  const travelled = stageTravelled(world);
  let cursor = world.stageCursor;
  let nextId = world.ships.nextId;
  const items = [...world.ships.items];
  const drops = [...world.stageDrops];
  while (cursor < script.entries.length) {
    const entry = script.entries[cursor];
    if (entry.at > travelled) break;
    const flight = buildFormation(
      world,
      entry,
      nextId,
      world.scrollY - FORM_AHEAD,
    );
    items.push(...flight);
    if (entry.drop !== undefined) {
      drops.push({
        ids: flight.map((s) => s.id),
        kind: entry.drop,
        x: entry.x,
        y: world.scrollY,
      });
    }
    nextId += entry.count;
    cursor += 1;
  }
  if (cursor === world.stageCursor) return world;
  return {
    ...world,
    stageCursor: cursor,
    stageDrops: drops,
    ships: { items, nextId },
  };
};

/** Mean position of a formation's survivors, or null once they are all gone. */
const survivorCentre = (
  world: World,
  ids: readonly number[],
): [number, number] | null => {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (const s of world.ships.items) {
    if (!ids.includes(s.id)) continue;
    sx += s.x;
    sy += s.y;
    n += 1;
  }
  return n === 0 ? null : [sx / n, sy / n];
};

/**
 * True when the formation left the field alive rather than being shot down.
 * Ships are culled once they fall behind the window, so a formation the pilot
 * simply flew away from vanishes the same way a destroyed one does — the last
 * place it was seen is what tells the two apart, and a wake-side exit pays
 * nothing. Otherwise every formation is a guaranteed power-up for dodging.
 */
const escaped = (d: StageDrop): boolean =>
  d.y > ARENA.y0 + ARENA.h || d.x < 0 || d.x > ARENA.w;

// Settle the pending rewards: track the survivors, and pay out where the last
// of them died.
const resolveDrops = (world: World): World => {
  if (world.stageDrops.length === 0) return world;
  const pending: StageDrop[] = [];
  const dropped: Pickup[] = [];
  let nextId = world.pickups.nextId;
  for (const d of world.stageDrops) {
    const centre = survivorCentre(world, d.ids);
    if (centre) {
      pending.push({ ...d, x: centre[0], y: centre[1] });
      continue;
    }
    if (escaped(d)) continue;
    dropped.push(placePickup(nextId, d.x, d.y, d.kind));
    nextId += 1;
  }
  if (dropped.length === 0 && pending.length === world.stageDrops.length) {
    return { ...world, stageDrops: pending };
  }
  return {
    ...world,
    stageDrops: pending,
    pickups: {
      items: [...world.pickups.items, ...dropped],
      nextId,
    },
  };
};

/**
 * Enter every formation the stage has now reached, then settle what the ones
 * already flying owe. Runs after the tick has committed, so the ships it adds
 * fly for the first time on the next one — the same deal the wave director and
 * the trickle get.
 */
export const stageStep = (world: World): World => {
  if (world.config.format !== "scroll") return world;
  if (world.flip || world.run?.over) return world;
  return resolveDrops(enterFormations(world));
};
