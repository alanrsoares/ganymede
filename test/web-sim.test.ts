// Characterization tests for the pure sim (world.ts `update`). The tick is a
// 666-line monolith; these lock its observable behavior (determinism +
// invariants) so it can be refactored into per-system functions safely later.
import { expect, test } from "bun:test";
import type { LightCycle } from "~/world";
import {
  type Archetype,
  CENTER_PAD,
  GRID_H,
  GRID_W,
  initWorld,
  MAX_LEVEL,
  TEAM_BASES,
  TEAMS,
  update,
  type World,
} from "~/world";
import {
  baseHitsRequired,
  cruiseFor,
  fullBaseHp,
  goalDelta,
  MATCH_REINFORCE_GENS,
  MAX_SHIPS,
  maxFuelFor,
  rollShip,
} from "~/world/factory";
import { createTickCtx, creditBaseHit } from "~/world/tick/context";

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

test("rally creates a short-lived command for the nearest living team", () => {
  const w0 = initWorld(5);
  const target = w0.ships.items[0];
  const [w1] = update({ kind: "rally", x: target.x, y: target.y }, w0);
  expect(w1.rally?.team).toBe(target.colorName);
  expect(w1.rally?.x).toBe(target.x);
  expect(w1.rally?.y).toBe(target.y);

  const [w2] = update({ kind: "tick", steps: 30, now: 0 }, w1);
  expect(w2.rally?.ttl).toBeLessThan(w1.rally?.ttl ?? 0);
});

test("rally pulls the targeted team toward the command beacon", () => {
  const [ship] = rollShip(7, 1, 100, 100, 3, "cyan", "fighter");
  const baseWorld = {
    ...initWorld(1),
    asteroids: { items: [], nextId: 1 },
    pickups: { items: [], nextId: 1 },
    ships: {
      items: [{ ...ship, dx: 1, dy: 0, vx: 0, vy: 0, fuel: ship.maxFuel }],
      nextId: 2,
    },
    baseHp: { ...fullBaseHp(), orange: 0, emerald: 0, pink: 0 },
  };
  const [neutral] = update({ kind: "tick", steps: 6, now: 0 }, baseWorld);
  const [commanded] = update(
    { kind: "tick", steps: 6, now: 0 },
    { ...baseWorld, rally: { team: "cyan", x: 180, y: 100, ttl: 120 } },
  );
  const neutralShip = neutral.ships.items[0];
  const commandedShip = commanded.ships.items[0];
  expect(commandedShip.x).toBeGreaterThan(neutralShip.x);
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

const enemyBaseNames = (team: string) =>
  TEAM_BASES.filter((b) => b.name !== team).map((b) => b.name);

test("creditBaseHit tallies raids exactly and banks raid XP toward rank", () => {
  const w0 = initWorld(1);
  const ship = {
    ...w0.ships.items[0],
    level: 1,
    xp: 0,
    colorName: "cyan",
    baseHits: {},
  };
  const ctx = createTickCtx(w0, 3, 0);
  ctx.moved = [ship];
  const enemies = enemyBaseNames("cyan");
  for (const e of enemies) creditBaseHit(ctx, ship.id, e);
  // The raid tally is exact regardless of any promotion it triggers.
  for (const e of enemies) {
    expect(ctx.moved[0].baseHits[e]).toBe(baseHitsRequired(1));
  }
  // Raiding is now a leveling stream (BASE_RAID_XP per hit), so the ship makes
  // rank progress — it never stays stuck at L1 with no XP banked. The full-raid
  // promote+heal+reset remains the center pad's job (finishAtCenterPad).
  expect(ctx.moved[0].level > 1 || ctx.moved[0].xp > 0).toBe(true);
});

// A cyan L1 ship that has already raided every enemy base, placed either over
// the center pad or well away from it.
const primedWorld = (over: boolean) => {
  const w0 = initWorld(1);
  const enemies = enemyBaseNames("cyan");
  const baseHits = Object.fromEntries(
    enemies.map((n) => [n, baseHitsRequired(1)]),
  );
  const s = {
    ...w0.ships.items[0],
    id: 1,
    level: 1,
    colorName: "cyan",
    x: over ? CENTER_PAD.x : 20,
    y: over ? CENTER_PAD.y : 20,
    baseHits,
  };
  return {
    ...w0,
    asteroids: { items: [], nextId: 1 },
    pickups: { items: [], nextId: 1 },
    bullets: { items: [], nextId: 1 },
    ships: { items: [s], nextId: 2 },
  };
};

test("center pad cashes the level-up once every enemy base is raided", () => {
  const [w] = update({ kind: "tick", steps: 1, now: 0 }, primedWorld(true));
  const s = w.ships.items.find((x) => x.id === 1);
  expect(s?.level).toBe(2);
  expect(Object.keys(s?.baseHits ?? {}).length).toBe(0); // tally reset on cash-in
});

test("a primed ship away from the center pad does not promote", () => {
  const [w] = update({ kind: "tick", steps: 1, now: 0 }, primedWorld(false));
  expect(w.ships.items.find((x) => x.id === 1)?.level).toBe(1);
});

test("a recon scout shares completed-raid credit with a nearby ally", () => {
  const w0 = initWorld(1);
  const enemies = enemyBaseNames("cyan");
  const baseHits = Object.fromEntries(
    enemies.map((n) => [n, baseHitsRequired(1)]),
  );
  const scout = {
    ...w0.ships.items[0],
    id: 1,
    colorName: "cyan",
    archetype: "scout" as Archetype,
    level: 1,
    x: 100,
    y: 100,
    baseHits,
  };
  const ally = {
    ...w0.ships.items[0],
    id: 2,
    colorName: "cyan",
    archetype: "fighter" as Archetype,
    level: 1,
    x: 140, // within RECON_SHARE_RADIUS (60) but clear of hull collision
    y: 100,
    baseHits: {},
  };
  const w1 = {
    ...w0,
    asteroids: { items: [], nextId: 1 },
    pickups: { items: [], nextId: 1 },
    bullets: { items: [], nextId: 1 },
    ships: { items: [scout, ally], nextId: 3 },
  };
  const [w] = update({ kind: "tick", steps: 1, now: 0 }, w1);
  const a = w.ships.items.find((x) => x.id === 2);
  for (const e of enemies) {
    expect(a?.baseHits[e]).toBe(baseHitsRequired(1));
  }
});

test("fuel cell: a carrier harvests it, refuels itself and pumps a thirsty ally", () => {
  const w0 = initWorld(3);
  const carrier = {
    ...w0.ships.items[0],
    id: 1,
    colorName: "cyan",
    archetype: "heavy" as Archetype, // heavy = carrier (fuelShare)
    level: 1,
    x: 100,
    y: 100,
    fuel: 50,
    baseHits: {},
  };
  const ally = {
    ...w0.ships.items[0],
    id: 2,
    colorName: "cyan",
    archetype: "fighter" as Archetype,
    level: 1,
    x: 130, // within FUEL_CELL_PUMP_RADIUS (45), clear of hull collision
    y: 100,
    fuel: 50,
    baseHits: {},
  };
  const w1: World = {
    ...w0,
    asteroids: { items: [], nextId: 1 },
    bullets: { items: [], nextId: 1 },
    pickups: {
      items: [{ id: 9, x: 100, y: 100, vx: 0, vy: 0, kind: 8, bob: 0 }],
      nextId: 10,
    },
    ships: { items: [carrier, ally], nextId: 3 },
  };
  const [w] = update({ kind: "tick", steps: 1, now: 0 }, w1);
  expect(w.pickups.items.some((p) => p.id === 9)).toBe(false); // cell consumed
  expect(w.ships.items.find((s) => s.id === 1)?.fuel).toBeGreaterThan(50); // carrier
  expect(w.ships.items.find((s) => s.id === 2)?.fuel).toBeGreaterThan(50); // ally pumped
});

test("fuel cell: a non-carrier coasts through and leaves it for a carrier", () => {
  const w0 = initWorld(3);
  const fighter = {
    ...w0.ships.items[0],
    id: 1,
    colorName: "cyan",
    archetype: "fighter" as Archetype,
    level: 1,
    x: 100,
    y: 100,
    fuel: 50,
    baseHits: {},
  };
  const w1: World = {
    ...w0,
    asteroids: { items: [], nextId: 1 },
    bullets: { items: [], nextId: 1 },
    pickups: {
      items: [{ id: 9, x: 100, y: 100, vx: 0, vy: 0, kind: 8, bob: 0 }],
      nextId: 10,
    },
    ships: { items: [fighter], nextId: 2 },
  };
  const [w] = update({ kind: "tick", steps: 1, now: 0 }, w1);
  expect(w.pickups.items.some((p) => p.id === 9)).toBe(true); // only carriers harvest
});

test("rank-gated pathing: L3+ steer across the world wrap, rookies go direct", () => {
  // Ship near the bottom edge (y=265, GRID_H=270), goal near the top (y=32).
  const atSeam = (level: number) =>
    ({ level, x: 240, y: 265 }) as unknown as LightCycle;
  // L2 rookie: direct course is straight up (negative dy toward y=32).
  expect(goalDelta(atSeam(2), 240, 32)[1]).toBeLessThan(0);
  // L3 veteran: shortest course crosses the bottom seam (positive dy, wraps).
  expect(goalDelta(atSeam(3), 240, 32)[1]).toBeGreaterThan(0);
});

test("range-aware refuel: a far ship low on fuel turns home before running dry", () => {
  const w0 = initWorld(7);
  const homeX = TEAM_BASES.find((b) => b.name === "cyan")?.x ?? 45;
  // Fuel (450/875 ≈ 51%) sits above the 30% hard floor, but below the range
  // reserve for the ~355-cell trip home — so the ship must peel off now.
  const ship = {
    ...w0.ships.items[0],
    id: 1,
    colorName: "cyan",
    archetype: "fighter" as Archetype,
    level: 2,
    x: 400,
    y: 135,
    dx: 1,
    dy: 0,
    vx: 1,
    vy: 0,
    hp: 3,
    maxHp: 3,
    fuel: 450,
    maxFuel: 875,
    baseHits: {},
  };
  let w: World = {
    ...w0,
    asteroids: { items: [], nextId: 1 },
    pickups: { items: [], nextId: 1 },
    bullets: { items: [], nextId: 1 },
    ships: { items: [ship], nextId: 2 },
  };
  for (let i = 0; i < 25; i++) {
    [w] = update({ kind: "tick", steps: 3, now: i * 100 }, w);
  }
  const s = w.ships.items.find((x) => x.id === 1);
  // It reversed its rightward heading and closed distance toward home.
  expect(Math.abs((s?.x ?? 400) - homeX)).toBeLessThan(400 - homeX);
});
