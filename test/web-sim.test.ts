// Characterization tests for the pure sim (world.ts `update`). The tick is a
// 666-line monolith; these lock its observable behavior (determinism +
// invariants) so it can be refactored into per-system functions safely later.
import { expect, test } from "bun:test";
import {
  GRID_H,
  GRID_W,
  initWorld,
  MAX_LEVEL,
  TEAM_BASES,
  TEAMS,
  update,
} from "~/web/world";
import {
  baseHitsRequired,
  cruiseFor,
  MATCH_REINFORCE_GENS,
  MAX_SHIPS,
  maxFuelFor,
} from "~/web/world/factory";
import { createTickCtx, creditBaseHit } from "~/web/world/tick/context";

const run = (seed: number, ticks: number, steps = 3) => {
  let w = initWorld(seed);
  for (let i = 0; i < ticks; i++) {
    [w] = update({ kind: "tick", steps, now: i * 100 }, w);
  }
  return w;
};

test("the sim is deterministic: same seed → identical world", () => {
  const a = run(1234, 200);
  const b = run(1234, 200);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test("different seeds diverge", () => {
  const a = run(1, 100);
  const b = run(2, 100);
  expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
});

test("invariants hold over a long run", () => {
  const w = run(99, 400);
  expect(w.ships.items.length).toBeLessThanOrEqual(MAX_SHIPS);
  for (const s of w.ships.items) {
    expect(s.hp).toBeLessThanOrEqual(s.maxHp);
    expect(s.shield).toBeLessThanOrEqual(s.maxShield);
    expect(s.level).toBeGreaterThanOrEqual(1);
    expect(s.level).toBeLessThanOrEqual(MAX_LEVEL);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Number.isFinite(s.y)).toBe(true);
    expect(s.x).toBeGreaterThanOrEqual(0);
    expect(s.x).toBeLessThan(GRID_W);
    expect(s.y).toBeGreaterThanOrEqual(0);
    expect(s.y).toBeLessThan(GRID_H);
  }
});

test("replenish reinforces an underdog (fewest-ships) team", () => {
  const w = initWorld(7);
  const count = (name: string) =>
    w.ships.items.filter((s) => s.colorName === name).length;
  const [w1] = update({ kind: "replenish" }, w);
  const added = w1.ships.items.at(-1);
  const minBefore = Math.min(...TEAMS.map((t) => count(t.name)));
  // the reinforced team had the fewest live ships before the spawn
  expect(count(added?.colorName ?? "")).toBe(minBefore);
});

test("sudden death freezes reinforcements", () => {
  const sd = { ...initWorld(1), age: MATCH_REINFORCE_GENS };
  const before = sd.ships.items.length;
  const [w] = update({ kind: "replenish" }, sd);
  expect(w.ships.items.length).toBe(before);
});

test("reset starts a fresh match", () => {
  const w = run(1, 100);
  const [w2] = update({ kind: "reset" }, w);
  expect(w2.age).toBe(0);
  expect(w2.winner).toBeNull();
  expect(w2.ships.items.length).toBeGreaterThan(0);
});

test("a razed base eliminates its team's ships", () => {
  const w0 = initWorld(3);
  const victim = TEAMS[0].name;
  const w = { ...w0, baseHp: { ...w0.baseHp, [victim]: 0 } };
  const [w1] = update({ kind: "tick", steps: 3, now: 0 }, w);
  expect(w1.ships.items.some((s) => s.colorName === victim)).toBe(false);
  // A living base keeps its team in play.
  const survivor = TEAMS[1].name;
  expect(w1.baseHp[survivor]).toBeGreaterThan(0);
});

test("launch adds a ship of the requested team", () => {
  const w0 = initWorld(5);
  const before = w0.ships.items.length;
  const [w1] = update({ kind: "launch", dir: "a" }, w0);
  expect(w1.ships.items.length).toBe(before + 1);
  expect(w1.ships.items.at(-1)?.colorName).toBe("cyan");
});

test("fuel: tank scales with archetype + level, requirement grows", () => {
  expect(maxFuelFor("scout", 1)).toBeLessThan(maxFuelFor("heavy", 1)); // carrier bigger
  expect(maxFuelFor("scout", 3)).toBeGreaterThan(maxFuelFor("scout", 1)); // level scales
  expect(baseHitsRequired(2)).toBeGreaterThan(baseHitsRequired(1)); // harder each rank
});

test("fuel drains while thrusting", () => {
  const w0 = initWorld(4);
  let w = w0;
  for (let i = 0; i < 60; i++)
    [w] = update({ kind: "tick", steps: 3, now: i * 100 }, w);
  // At least one ship has burned into its tank (not everyone is parked at base).
  expect(w.ships.items.some((s) => s.fuel < s.maxFuel)).toBe(true);
});

test("out of fuel: no weapons fire, engine coasts down", () => {
  const w0 = initWorld(3);
  const dry = {
    ...w0,
    asteroids: { items: [], nextId: w0.asteroids.nextId },
    ships: {
      ...w0.ships,
      items: w0.ships.items.map((s) => ({ ...s, fuel: 0, fireCooldown: 0 })),
    },
  };
  const [w] = update({ kind: "tick", steps: 3, now: 0 }, dry);
  expect(w.bullets.items.length).toBe(0);
  for (const s of w.ships.items) {
    // Dead engine → speed decays, never accelerates toward cruise.
    expect(Math.hypot(s.vx, s.vy)).toBeLessThan(
      cruiseFor(s.archetype, s.level),
    );
  }
});

test("docked ship refuels at its home base", () => {
  const w0 = initWorld(2);
  const s0 = w0.ships.items[0];
  const base = TEAM_BASES.find((b) => b.name === s0.colorName);
  if (!base) throw new Error("no home base");
  const low = { ...s0, x: base.x, y: base.y, fuel: 10 };
  const w1 = {
    ...w0,
    asteroids: { items: [], nextId: w0.asteroids.nextId },
    ships: { ...w0.ships, items: [low] },
  };
  const [w] = update({ kind: "tick", steps: 3, now: 0 }, w1);
  const after = w.ships.items.find((s) => s.id === low.id);
  expect(after?.fuel).toBeGreaterThan(10);
});

test("base-raid leveling: hit every enemy base → level up, tally resets, ramps", () => {
  const w0 = initWorld(1);
  const ship = {
    ...w0.ships.items[0],
    level: 1,
    colorName: "cyan",
    baseHits: {},
  };
  const ctx = createTickCtx(w0, 3, 0);
  ctx.moved = [ship];
  const enemies = TEAMS.filter((t) => t.name !== "cyan").map((t) => t.name);
  // L1 → need 1 hit on each enemy base.
  for (const e of enemies) creditBaseHit(ctx, ship.id, e);
  expect(ctx.moved[0].level).toBe(2);
  expect(Object.keys(ctx.moved[0].baseHits).length).toBe(0); // reset on promote
  // L2 → need 2 each: one round isn't enough, two is.
  for (const e of enemies) creditBaseHit(ctx, ship.id, e);
  expect(ctx.moved[0].level).toBe(2);
  for (const e of enemies) creditBaseHit(ctx, ship.id, e);
  expect(ctx.moved[0].level).toBe(3);
});
