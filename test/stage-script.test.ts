// Authored scroll stages (#30): a script of formations placed by distance, and
// the spread emitter a formation can carry to hold a lane.

import { afterEach, expect, test } from "bun:test";
import type { Seed } from "~/engine/rng";
import {
  ARENA,
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  initArcadeWorld,
  type MatchConfig,
  SCROLL_RATE,
  type StageScript,
  setGridBounds,
  syncField,
  type World,
} from "~/world";
import { tick } from "~/world/tick";
import { DEFAULT_CONFIG, SPREAD_EMITTER_BARRELS } from "~/world/tuning";

afterEach(() => setGridBounds(DEFAULT_GRID_W, DEFAULT_GRID_H));

const scriptConfig = (
  stage: StageScript,
  format: "scroll" | "arcade" = "scroll",
): MatchConfig => ({
  ...DEFAULT_CONFIG,
  format,
  run: {
    playerRole: "pilot",
    difficulty: "normal",
    playerTeam: "cyan",
    playerArchetype: "fighter",
    victory: { kind: "none" },
    defeat: { kind: "lives", count: 3 },
    enemyTeams: ["orange"],
    stage,
  },
});

const oneLine: StageScript = {
  name: "test",
  entries: [
    { at: 60, x: 240, shape: "line", count: 3, hull: "scout", level: 1 },
  ],
};

const stageWorld = (
  stage: StageScript,
  format: "scroll" | "arcade" = "scroll",
): World => {
  const w = initArcadeWorld(7 as Seed, scriptConfig(stage, format));
  syncField(w);
  // No rocks: a formation that flies into an asteroid is a different test.
  return { ...w, asteroids: { items: [], nextId: 1 } };
};

const enemies = (w: World) =>
  w.ships.items.filter((s) => s.id !== w.controlledShipId);

// Fly `cells` of stage at one generation per tick.
const fly = (w: World, cells: number): World => {
  let out = w;
  for (let i = 0; i < Math.ceil(cells / SCROLL_RATE); i++)
    out = tick(out, 1, 16 * i);
  return out;
};

// Fly until the next formation has entered, and stop on that tick — formations
// are spawned after the tick commits, so this is the one moment they are still
// standing where the script put them.
const flyToEntry = (w: World, limit = 2000): World => {
  let out = w;
  for (let i = 0; i < limit; i++) {
    out = tick(out, 1, 16 * i);
    if (out.stageCursor > w.stageCursor) return out;
  }
  throw new Error("no formation entered");
};

test("a formation waits for its authored distance", () => {
  const w = stageWorld(oneLine);
  expect(enemies(w).length).toBe(0);
  // Just short of `at`: still nothing on the field.
  expect(enemies(fly(w, 50)).length).toBe(0);
  expect(enemies(flyToEntry(w)).length).toBe(3);
});

test("a formation enters once and only once", () => {
  // The cursor is the point: a filter over `at` would re-spawn the line on
  // every tick after it, which reads as an infinite stream, not a stage. The
  // line itself is long gone by then — it flies down-stage and off the trailing
  // edge — so the count that matters is how many ids the stage ever issued.
  const entered = flyToEntry(stageWorld(oneLine));
  const later = fly(entered, 400);
  expect(later.stageCursor).toBe(1);
  expect(later.ships.nextId).toBe(entered.ships.nextId);
});

test("the cursor survives a tick", () => {
  // finalize rebuilds the World from scratch, so a cursor it forgets to carry
  // resets to 0 and the whole stage flies again from the top.
  expect(flyToEntry(stageWorld(oneLine)).stageCursor).toBe(1);
});

test("a script replaces the placeholder trickle", () => {
  // Long enough to cross several trickle beats (SCROLL_SPAWN_GENS): a scripted
  // stage's population is exactly what was authored, nothing more.
  const flown = fly(stageWorld(oneLine), 400);
  expect(flown.ships.nextId).toBe(stageWorld(oneLine).ships.nextId + 3);
});

test("a line forms up abreast, ahead of the window", () => {
  const line = enemies(flyToEntry(stageWorld(oneLine)));
  const xs = line.map((s) => s.x).sort((a, b) => a - b);
  expect(xs[1]).toBe(240); // centred on the authored x
  expect(xs[2] - xs[1]).toBeCloseTo(xs[1] - xs[0], 9); // evenly spaced
  // Entering from up-stage, nose-down: forward is -y, so they come from
  // smaller y than the pilot and fly toward larger y.
  for (const s of line) expect(s.dy).toBeGreaterThan(0);
});

test("a vee trails its wings", () => {
  const vee: StageScript = {
    name: "test",
    entries: [
      { at: 60, x: 240, shape: "vee", count: 3, hull: "scout", level: 1 },
    ],
  };
  const flight = enemies(flyToEntry(stageWorld(vee))).sort((a, b) => a.x - b.x);
  expect(flight[1].y).toBeLessThan(flight[0].y); // nose leads
  expect(flight[0].y).toBe(flight[2].y); // wings level with each other
});

test("a wide formation authored at the edge stays inside the corridor", () => {
  const edge: StageScript = {
    name: "test",
    entries: [
      { at: 60, x: 6, shape: "line", count: 5, hull: "scout", level: 1 },
    ],
  };
  for (const s of enemies(flyToEntry(stageWorld(edge)))) {
    expect(s.x).toBeGreaterThanOrEqual(0);
    expect(s.x).toBeLessThanOrEqual(ARENA.w);
  }
});

test("a script does nothing outside a scroll stage", () => {
  // An arena run has no scroll position to measure `at` against; attaching a
  // stage to one must not quietly spawn its whole script at distance zero.
  const w = stageWorld(oneLine, "arcade");
  expect(tick(w, 60, 16).stageCursor).toBe(0);
});

// --- the spread emitter ------------------------------------------------------

const emitterScript = (emitter?: "spread"): StageScript => ({
  name: "test",
  entries: [
    {
      at: 6,
      x: 40,
      shape: "line",
      count: 1,
      hull: "fighter",
      level: 2,
      emitter,
    },
  ],
});

// Bolts on the field belonging to the stage's formation, after it has had long
// enough to clear its initial reload.
const formationBolts = (emitter?: "spread", gens = 120): number => {
  const entered = flyToEntry(stageWorld(emitterScript(emitter)));
  // Park the pilot in the far corner of the corridor, well outside any weapon's
  // reach: what is being measured is whether the formation shoots at *nothing*.
  let w: World = {
    ...entered,
    ships: {
      ...entered.ships,
      items: entered.ships.items.map((s) =>
        s.id === entered.controlledShipId
          ? { ...s, x: ARENA.w - 20, y: ARENA.y0 + ARENA.h - 20 }
          : s,
      ),
    },
  };
  const ids = new Set(enemies(w).map((s) => s.id));
  const fired = new Set<number>();
  for (let i = 0; i < gens; i++) {
    w = tick(w, 1, 16 * i);
    for (const b of w.bullets.items) if (ids.has(b.owner)) fired.add(b.id);
  }
  return fired.size;
};

test("a spread emitter fires with nobody in reach", () => {
  // The authored point of the emitter: it holds a band of the corridor whether
  // or not the pilot is in it, so the gaps between bolts are the level design.
  // One salvo is the whole fan, so the first shot is SPREAD_EMITTER_BARRELS.
  expect(formationBolts("spread")).toBe(SPREAD_EMITTER_BARRELS);
});

test("an aimed formation holds fire instead", () => {
  // Same formation, same distance, no emitter — a scroll stage has no bases to
  // strafe, so an aimed ship with no target in range has nothing to shoot at.
  expect(formationBolts()).toBe(0);
});
