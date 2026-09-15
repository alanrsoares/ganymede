// What a scroll stage owes the pilot: a tank that isn't a countdown, and a
// respawn that puts them back on the stage rather than at a base the stage flew
// past thousands of cells ago.

import { afterEach, expect, test } from "bun:test";
import type { Seed } from "~/engine/rng";
import {
  ARENA,
  baseByName,
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  initArcadeWorld,
  type LightCycle,
  type MatchConfig,
  setGridBounds,
  syncField,
  type World,
} from "~/world";
import { tick } from "~/world/tick";
import { DEFAULT_CONFIG } from "~/world/tuning";

afterEach(() => setGridBounds(DEFAULT_GRID_W, DEFAULT_GRID_H));

const runConfig = (format: "arcade" | "scroll"): MatchConfig => ({
  ...DEFAULT_CONFIG,
  teams: 2,
  format,
  run: {
    playerRole: "pilot",
    difficulty: "normal",
    playerTeam: "cyan",
    playerArchetype: "fighter",
    victory: { kind: "none" },
    defeat: { kind: "lives", count: 3 },
    enemyTeams: ["orange"],
  },
});

const runWorld = (format: "arcade" | "scroll"): World => {
  const w = initArcadeWorld(3 as Seed, runConfig(format));
  syncField(w);
  return { ...w, asteroids: { items: [], nextId: 1 } };
};

const pilot = (w: World): LightCycle | undefined =>
  w.ships.items.find((s) => s.id === w.controlledShipId);

const fly = (w: World, gens: number): World => {
  let out = w;
  for (let i = 0; i < gens; i++) out = tick(out, 1, 16 * i);
  return out;
};

test("a stage doesn't burn the tank", () => {
  // A stage has no base to dock at and no pads to sip from, so a burning tank
  // is a countdown to a dead engine — which then drifts slower than the window
  // scrolls and ends up wedged against the bottom edge with no way back.
  const w = runWorld("scroll");
  const before = pilot(w)?.fuel ?? 0;
  expect(before).toBeGreaterThan(0);
  expect(pilot(fly(w, 400))?.fuel).toBe(before);
});

test("the arena still spends fuel", () => {
  // The fix is about the stage, not about retiring fuel: in the arena, where
  // there is somewhere to refill, the tank is still a resource.
  const w = runWorld("arcade");
  const before = pilot(w)?.fuel ?? 0;
  expect(pilot(fly(w, 60))?.fuel).toBeLessThan(before);
});

test("a respawn on a stage puts the pilot back in the live window", () => {
  // Fly far enough that the arena's bases are well behind the window, then take
  // the pilot off the field: the next tick burns a life and respawns.
  const flown = fly(runWorld("scroll"), 300);
  const dead: World = {
    ...flown,
    ships: {
      ...flown.ships,
      items: flown.ships.items.filter((s) => s.id !== flown.controlledShipId),
    },
  };
  const back = tick(dead, 1, 16);
  const me = pilot(back);
  expect(back.run?.lives).toBe(2);
  expect(me).toBeDefined();
  if (!me) return;
  expect(me.y).toBeGreaterThanOrEqual(ARENA.y0);
  expect(me.y).toBeLessThanOrEqual(ARENA.y0 + ARENA.h);
  expect(me.x).toBeGreaterThanOrEqual(0);
  expect(me.x).toBeLessThanOrEqual(ARENA.w);
});

test("an arena respawn still launches from the home base", () => {
  const flown = fly(runWorld("arcade"), 60);
  const dead: World = {
    ...flown,
    ships: {
      ...flown.ships,
      items: flown.ships.items.filter((s) => s.id !== flown.controlledShipId),
    },
  };
  const me = pilot(tick(dead, 1, 16));
  expect(me).toBeDefined();
  const home = baseByName.get("cyan");
  if (me && home) {
    expect(me.x).toBe(home.x);
    expect(me.y).toBe(home.y);
  }
});

test("stage enemies have no base to fly off to", () => {
  // The raid objective is arena furniture. Left on, it pulled the flock toward
  // absolute base coordinates the stage has no business visiting, so a stage
  // read as somebody else's team battle happening next to the corridor.
  const flown = fly(runWorld("scroll"), 500);
  const me = pilot(flown);
  expect(me).toBeDefined();
  const enemies = flown.ships.items.filter(
    (s) => s.id !== flown.controlledShipId,
  );
  expect(enemies.length).toBeGreaterThan(0);
  // Everything still on the field is on the field: the cull would have taken
  // anything that struck out for a base, so what survives flew the corridor.
  for (const e of enemies) {
    expect(e.x).toBeGreaterThanOrEqual(-ARENA.w);
    expect(e.x).toBeLessThanOrEqual(ARENA.w * 2);
  }
});
