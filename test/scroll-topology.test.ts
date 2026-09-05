// The scroll topology (#27): a fixed-width window sliding along a tall stage,
// both axes open, versus the all-range torus the game has always been. The
// flip beat closes the window back into that torus without moving anything.

import { afterEach, expect, test } from "bun:test";
import type { Seed } from "~/engine/rng";
import {
  ARENA,
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  initArcadeWorld,
  initWorld,
  type MatchConfig,
  SCROLL_FIELD_W,
  SCROLL_RATE,
  setGridBounds,
  syncField,
  TEAM_BASES,
  update,
  type World,
} from "~/world";
import { inField, wrapX, wrapY } from "~/world/math";
import { tick } from "~/world/tick";
import { CULL_MARGIN, DEFAULT_CONFIG } from "~/world/tuning";

afterEach(() => setGridBounds(DEFAULT_GRID_W, DEFAULT_GRID_H));

const scrollConfig = (): MatchConfig => ({
  ...DEFAULT_CONFIG,
  format: "scroll",
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

const scrollWorld = (): World => initArcadeWorld(7 as Seed, scrollConfig());

test("a scroll stage is an open window, not a torus", () => {
  const w = scrollWorld();
  syncField(w);
  expect(ARENA).toMatchObject({
    x0: 0,
    y0: 0,
    w: SCROLL_FIELD_W,
    h: DEFAULT_GRID_H,
    wrapX: false,
    wrapY: false,
  });
});

test("stage width is fixed, not taken from the canvas aspect", () => {
  // An ultrawide window would otherwise hand the player a wider world.
  setGridBounds(900, DEFAULT_GRID_H);
  syncField(scrollWorld());
  expect(ARENA.w).toBe(SCROLL_FIELD_W);
});

test("autobattle and arcade still get the all-range torus", () => {
  for (const w of [
    initWorld(1 as Seed),
    initArcadeWorld(1 as Seed, {
      ...scrollConfig(),
      format: "arcade",
    }),
  ]) {
    syncField(w);
    expect(ARENA).toMatchObject({ x0: 0, y0: 0, wrapX: true, wrapY: true });
  }
});

test("the tick advances the stage, and the field origin follows it", () => {
  let w = scrollWorld();
  w = tick(w, 10, 16);
  // Forward is -y, so the window climbs toward smaller y (see SCROLL_RATE).
  expect(w.scrollY).toBeCloseTo(-SCROLL_RATE * 10, 6);
  expect(ARENA.y0).toBeCloseTo(w.scrollY, 6);
});

test("a halted stage holds position — the flip beat's freeze", () => {
  let w = { ...scrollWorld(), scrollHalted: true };
  w = tick(w, 10, 16);
  expect(w.scrollY).toBe(0);
});

test("the flip closes the window into exactly today's arena", () => {
  const w = { ...scrollWorld(), scrollY: 4200, scrollHalted: true };
  syncField(w);
  expect(ARENA).toMatchObject({
    x0: 0,
    y0: 4200,
    w: DEFAULT_GRID_W,
    h: DEFAULT_GRID_H,
    wrapX: true,
    wrapY: true,
  });
});

test("nothing folds back: the stage axis is open", () => {
  syncField(scrollWorld());
  // Past either edge of the window, coordinates keep going. This is the whole
  // claim of "flies forward forever" — which way is forward is the camera's
  // business (#28), and the axis is open in both directions either way.
  expect(wrapY(DEFAULT_GRID_H + 50)).toBe(DEFAULT_GRID_H + 50);
  expect(wrapY(-30)).toBe(-30);
  expect(wrapX(SCROLL_FIELD_W + 12)).toBe(SCROLL_FIELD_W + 12);

  // The same coordinates fold on the all-range torus, as they always have.
  syncField(initWorld(1 as Seed));
  expect(wrapY(DEFAULT_GRID_H + 50)).toBe(50);
  expect(wrapY(-30)).toBe(DEFAULT_GRID_H - 30);
});

test("an unsteered body crosses the window edge without folding", () => {
  let w = scrollWorld();
  const ship = w.ships.items[0];
  w = {
    ...w,
    ships: {
      ...w.ships,
      items: [{ ...ship, id: 99, x: 240, y: 260, dx: 0, dy: 1, vx: 0, vy: 3 }],
    },
    controlledShipId: null,
  };
  const ys: number[] = [];
  for (let i = 0; i < 12; i++) {
    w = tick(w, 5, 16 * i);
    const me = w.ships.items.find((s) => s.id === 99);
    if (me) ys.push(me.y);
  }
  // A torus would have folded at least one of these back near zero.
  expect(Math.min(...ys)).toBeGreaterThan(200);
  expect(Math.max(...ys)).toBeGreaterThan(DEFAULT_GRID_H);
});

test("the pilot is walled in on x; the enemies are not", () => {
  let w = scrollWorld();
  const pilot = w.ships.items[0];
  const enemy = { ...pilot, id: 99, colorName: "orange", x: 470 };
  w = {
    ...w,
    ships: {
      ...w.ships,
      items: [
        { ...pilot, x: 476, y: 60, dx: 1, dy: 0, vx: 4, vy: 0 },
        { ...enemy, y: 200, dx: 1, dy: 0, vx: 4, vy: 0 },
      ],
    },
  };
  for (let i = 0; i < 12; i++) w = tick(w, 10, 16 * i);

  const me = w.ships.items.find((s) => s.id === pilot.id);
  const them = w.ships.items.find((s) => s.id === 99);
  expect(me?.x).toBeLessThanOrEqual(SCROLL_FIELD_W);
  expect(me?.x).toBeGreaterThan(SCROLL_FIELD_W - 40); // held at the wall
  expect(them?.x).toBeGreaterThan(SCROLL_FIELD_W); // sailed off the side
});

// --- culling: the field rect, inflated, is the whole rule ---------------------

test("the cull rule is inert on a torus and live on an open field", () => {
  syncField(initWorld(1 as Seed));
  expect(inField(-9999, -9999)).toBe(true); // a torus has no outside

  syncField(scrollWorld());
  expect(inField(240, 135)).toBe(true);
  expect(inField(240, -CULL_MARGIN - 1)).toBe(false); // behind the camera
  expect(inField(SCROLL_FIELD_W + CULL_MARGIN + 1, 135)).toBe(false); // off the side
  // Inside the margin is still alive, so a formation can fly in from off-screen.
  expect(inField(240, -CULL_MARGIN + 1)).toBe(true);
});

test("the wake is culled, the pilot never is", () => {
  let w = scrollWorld();
  const pilot = w.ships.items[0];
  const trailing = {
    ...pilot,
    id: 42,
    colorName: "orange",
    x: 240,
    y: -CULL_MARGIN - 60,
    vx: 0,
    vy: 0,
  };
  // Park the pilot equally far behind: protection, not position, keeps it.
  w = {
    ...w,
    ships: {
      ...w.ships,
      items: [{ ...pilot, x: 240, y: -CULL_MARGIN - 60 }, trailing],
    },
  };
  w = tick(w, 1, 16);

  expect(w.ships.items.some((s) => s.id === 42)).toBe(false);
  expect(w.ships.items.some((s) => s.id === pilot.id)).toBe(true);
});

test("bullets left behind the window are dropped", () => {
  let w = scrollWorld();
  w = {
    ...w,
    bullets: {
      items: [
        { ...(w.bullets.items[0] ?? {}) },
        {
          id: 1,
          x: 240,
          y: -CULL_MARGIN - 40,
          vx: 0,
          vy: 0,
          team: "orange",
          rgb: [1, 1, 1],
          angle: 0,
          life: 999,
          damage: 1,
          ownerId: 99,
        },
      ].slice(1) as typeof w.bullets.items,
      nextId: 2,
    },
  };
  w = tick(w, 1, 16);
  expect(w.bullets.items.length).toBe(0);
});

test("scenery refills onto the live window, not back at world zero", () => {
  let w = { ...scrollWorld(), scrollY: 5000 };
  w = tick(w, 1, 16);
  // Every rock the refill rolled sits on the field that scrolled to y=5000.
  for (const r of w.asteroids.items) {
    expect(inField(r.x, r.y)).toBe(true);
  }
  expect(w.asteroids.items.length).toBeGreaterThan(0);
});

// --- regressions caught in review ------------------------------------------

test("resetting a stage gives back a stage, not an autobattle world", () => {
  const w = update({ kind: "reset" }, scrollWorld());
  expect(w.run).not.toBeNull();
  expect(w.controlledShipId).not.toBeNull();
  expect(w.config.format).toBe("scroll");
});

test("a fresh world derives its own field before rolling scenery", () => {
  // Leave the field parked far up a stage, as a finished run would.
  syncField({
    config: scrollConfig(),
    scrollY: -9000,
    scrollHalted: false,
  });

  // Same seed, same config: the opening must not depend on what ran before.
  const a = initWorld(99 as Seed);
  syncField({ config: scrollConfig(), scrollY: -9000, scrollHalted: false });
  const b = initWorld(99 as Seed);
  expect(a.asteroids.items.map((r) => [r.x, r.y])).toEqual(
    b.asteroids.items.map((r) => [r.x, r.y]),
  );
  // ...and it is the all-range field, not the stale stage position.
  for (const r of a.asteroids.items) expect(r.y).toBeGreaterThan(-1000);
});

// A lone ship flying into an enemy base, with the scenery pools emptied so
// nothing else can touch it. Returns its heading after a few ticks: bouncing
// off the base reverses it, flying through where the base would be does not.
const headingIntoABase = (world: World): number => {
  const pilot = world.ships.items[0];
  const base = TEAM_BASES[1]; // orange: an enemy of the cyan pilot
  let w: World = {
    ...world,
    asteroids: { items: [], nextId: 1 },
    pickups: { items: [], nextId: 1 },
    ships: {
      ...world.ships,
      items: [
        // Just inside the base's collision radius and closing on it — dead
        // centre reads as degenerate and is skipped by the narrow phase.
        {
          ...pilot,
          x: base.x - 6,
          y: base.y - 6,
          dx: 0.7071,
          dy: 0.7071,
          vx: 2,
          vy: 2,
          invulnTime: 0,
          hitCooldown: 0,
        },
      ],
    },
    controlledShipId: null, // no pilot input or field clamp in the way
  };
  for (let i = 0; i < 2; i++) w = tick(w, 1, 16 * i);
  const me = w.ships.items.find((s) => s.id === pilot.id);
  return me ? Math.sign(me.vx) : 0;
};

test("a stage does not collide with arena furniture", () => {
  const arena = initArcadeWorld(7 as Seed, {
    ...scrollConfig(),
    format: "arcade",
  });
  // The all-range arena has a base there, and flying into it bounces you back.
  expect(headingIntoABase(arena)).toBe(-1);
  // The stage flies past where it would be, so there is nothing to hit.
  expect(headingIntoABase(scrollWorld())).toBe(1);
});
