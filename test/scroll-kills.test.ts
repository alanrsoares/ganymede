// A scroll stage has no wave director, and the run's kill count used to be
// inferred from one: a drop in the wave's live enemy count. Stages count their
// kills where the ship actually dies instead, so a hostile that flies off the
// bottom of the window is not credited and one that is shot down is.

import { afterEach, expect, test } from "bun:test";
import type { Seed } from "~/engine/rng";
import {
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  initArcadeWorld,
  type MatchConfig,
  setGridBounds,
  syncField,
  type World,
} from "~/world";
import { tick } from "~/world/tick";
import { BULLET_SPEED, DEFAULT_CONFIG } from "~/world/tuning";

afterEach(() => setGridBounds(DEFAULT_GRID_W, DEFAULT_GRID_H));

const scrollConfig = (): MatchConfig => ({
  ...DEFAULT_CONFIG,
  format: "scroll",
  reinforceGens: 0, // what the lobby launches with: no autobattle replacements
  run: {
    playerRole: "pilot",
    difficulty: "normal",
    playerTeam: "cyan",
    playerArchetype: "fighter",
    victory: { kind: "none" },
    defeat: { kind: "lives", count: 3 },
    enemyTeams: ["orange"],
    stage: { name: "test", entries: [] },
  },
});

const scrollWorld = (): World => {
  const w = initArcadeWorld(7 as Seed, scrollConfig());
  syncField(w);
  return {
    ...w,
    asteroids: { items: [], nextId: 1 },
    pickups: { items: [], nextId: 1 },
  };
};

/** A doomed hostile, parked in the window in front of a cyan bolt. */
const doomed = (w: World) => {
  const pilot = w.ships.items[0];
  return {
    ...pilot,
    id: 900,
    colorName: "orange",
    x: 120,
    y: w.scrollY + 100,
    vx: 0,
    vy: 0,
    hp: 1,
    shield: 0,
    invulnTime: 0,
  };
};

const bolt = (x: number, y: number) => ({
  id: 1,
  x,
  y,
  vx: BULLET_SPEED,
  vy: 0,
  team: "cyan",
  rgb: [0, 0.78, 1] as const,
  angle: Math.atan2(0, 1),
  damage: 40,
  life: 120,
  owner: 0,
  bounces: 0,
  kind: 0,
});

test("a hostile shot down on a stage is a kill", () => {
  const w = scrollWorld();
  const enemy = doomed(w);
  const armed: World = {
    ...w,
    ships: { items: [w.ships.items[0], enemy], nextId: 901 },
    bullets: { items: [bolt(enemy.x - 4, enemy.y)], nextId: 2 },
  };
  expect(armed.run?.kills).toBe(0);

  const hit = tick(armed, 1, 16);
  expect(hit.ships.items.map((s) => s.id)).not.toContain(900);
  expect(hit.run?.kills).toBe(1);
});

test("a hostile that flies off the stage is not", () => {
  const w = scrollWorld();
  // Parked well behind the window, in the wake: the cull takes it, and a cull
  // is not something the pilot did.
  const escapee = { ...doomed(w), y: w.scrollY + DEFAULT_GRID_H + 400 };
  const flown = tick(
    { ...w, ships: { items: [w.ships.items[0], escapee], nextId: 901 } },
    1,
    16,
  );
  expect(flown.ships.items.map((s) => s.id)).not.toContain(900);
  expect(flown.run?.kills).toBe(0);
});
