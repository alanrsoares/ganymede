// The player control model (#29): Ganymede's inertial thrust versus the classic
// vertical-shmup direct stick, both live behind one World field so a pilot can
// flip between them mid-stage and feel the difference.

import { afterEach, expect, test } from "bun:test";
import type { Seed } from "~/engine/rng";
import {
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  initArcadeWorld,
  type LightCycle,
  type MatchConfig,
  SCROLL_RATE,
  setGridBounds,
  syncField,
  update,
  type World,
} from "~/world";
import { tick } from "~/world/tick";
import { DEFAULT_CONFIG } from "~/world/tuning";

afterEach(() => setGridBounds(DEFAULT_GRID_W, DEFAULT_GRID_H));

const runConfig = (format: "arcade" | "scroll"): MatchConfig => ({
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
  },
});

// A piloted world with the rock field cleared, so nothing bumps the pilot.
//
// The field's gravity wells (bases, portals, the centre pad) still add to
// velocity after motion runs, which is why the assertions below are stated
// against cruise speed rather than bit-exact: a "stopped" ship is one the
// control model contributed nothing to, not one nothing in the sim touched.
const pilotWorld = (format: "arcade" | "scroll" = "scroll"): World => {
  const w = initArcadeWorld(11 as Seed, runConfig(format));
  syncField(w);
  return { ...w, asteroids: { items: [], nextId: 1 } };
};

const pilot = (w: World): LightCycle => {
  const s = w.ships.items.find((x) => x.id === w.controlledShipId);
  if (!s) throw new Error("expected a piloted ship on this world");
  return s;
};

const press = (w: World, keys: Partial<World["controlKeys"]>): World =>
  update(
    {
      kind: "controlKeys",
      up: false,
      down: false,
      left: false,
      right: false,
      space: false,
      ...keys,
    },
    w,
  );

const direct = (w: World): World =>
  update({ kind: "controlModel", model: "direct" }, w);

test("a fresh world flies the inertial model", () => {
  // The toggle is opt-in: every existing match — autobattle, arcade, the attract
  // scene — has to behave exactly as it did before this landed.
  expect(pilotWorld("arcade").controlModel).toBe("inertial");
});

test("the model survives a tick", () => {
  // It lives on the World, and finalize rebuilds the World from scratch every
  // tick; a field it forgets to carry would silently revert mid-flight.
  expect(tick(direct(pilotWorld()), 5, 16).controlModel).toBe("direct");
});

test("releasing the stick stops a direct pilot dead", () => {
  let w = press(direct(pilotWorld("arcade")), { right: true });
  for (let i = 0; i < 6; i++) w = tick(w, 1, 16 * i);
  expect(pilot(w).vx).toBeGreaterThan(0);

  w = press(w, {});
  w = tick(w, 1, 16);
  expect(Math.hypot(pilot(w).vx, pilot(w).vy)).toBeLessThan(0.1);
});

test("an inertial pilot coasts instead", () => {
  // The distinguishing texture, stated as a test: the same released stick leaves
  // the ship carrying its momentum at cruise.
  let w = press(pilotWorld("arcade"), { right: true });
  for (let i = 0; i < 6; i++) w = tick(w, 1, 16 * i);
  w = press(w, {});
  for (let i = 0; i < 4; i++) w = tick(w, 1, 16 * i);
  expect(Math.hypot(pilot(w).vx, pilot(w).vy)).toBeGreaterThan(0.5);
});

test("a direct pilot reaches full speed on the first step", () => {
  // No ramp: press and the ship is already at cruise, which is the whole point
  // of the model for formation dodging.
  const w0 = press(direct(pilotWorld("arcade")), { right: true });
  const s0 = pilot(w0);
  const s1 = pilot(tick(w0, 1, 16));
  expect(s1.vx).toBeGreaterThan(Math.hypot(s0.vx, s0.vy) * 0.9);
  expect(Math.abs(s1.vy)).toBeLessThan(0.05);
});

test("diagonals are not a speed bonus under direct control", () => {
  const straight = pilot(
    tick(press(direct(pilotWorld("arcade")), { right: true }), 1, 16),
  );
  const diagonal = pilot(
    tick(
      press(direct(pilotWorld("arcade")), { right: true, down: true }),
      1,
      16,
    ),
  );
  expect(Math.hypot(diagonal.vx, diagonal.vy)).toBeCloseTo(
    Math.hypot(straight.vx, straight.vy),
    2,
  );
});

test("a centred direct stick holds screen position on a scroll stage", () => {
  // "Stopped" on a moving stage has to mean stopped on screen, so a released
  // stick rides the window at its own rate rather than sliding off the trailing
  // edge. Forward is -y, so that drift is negative.
  // Exact here, unlike the arena specs above: a scroll stage has no furniture,
  // so nothing else is adding to the pilot's velocity.
  const w = tick(direct(pilotWorld("scroll")), 1, 16);
  expect(pilot(w).vy).toBeCloseTo(-SCROLL_RATE, 9);
  expect(pilot(w).vx).toBe(0);
});

test("a parked direct pilot keeps its nose where it was pointed", () => {
  let w = press(direct(pilotWorld("arcade")), { right: true });
  for (let i = 0; i < 4; i++) w = tick(w, 1, 16 * i);
  const aimed = pilot(w);
  w = tick(press(w, {}), 1, 16);
  expect(pilot(w).dx).toBeCloseTo(aimed.dx, 2);
  expect(pilot(w).dy).toBeCloseTo(aimed.dy, 2);
});

test("the model only touches the pilot", () => {
  // Enemies fly the flock, and the flock is inertial by construction — a stray
  // branch that read controlModel for everyone would freeze the whole field.
  let w = direct(pilotWorld("scroll"));
  for (let i = 0; i < 200; i++) w = tick(w, 1, 16 * i);
  const enemies = w.ships.items.filter((s) => s.id !== w.controlledShipId);
  expect(enemies.length).toBeGreaterThan(0);
  for (const e of enemies) expect(Math.hypot(e.vx, e.vy)).toBeGreaterThan(0);
});
