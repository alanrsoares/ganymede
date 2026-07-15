// CPU broad-phase (src/world/tick/broadphase) validation. Two layers:
//   1. the grid enumerator produces exactly the brute oracle's pair set/order;
//   2. feeding that candidate list to resolveShipCollisions yields a world
//      bit-identical to the untouched nested O(n²) loop — the seam that a GPU
//      pair list will later drop into.
import { expect, test } from "bun:test";
import { nextFloat, type Seed } from "~/engine/rng";
import { initWorld, type LightCycle, setGridBounds, update } from "~/world";
import { ENGAGE_RADIUS, flockSteer, rollShip } from "~/world/factory";
import {
  bruteCrossPairs,
  bruteSelfPairs,
  gridCrossPairs,
  gridNeighbors,
  gridSelfPairs,
  type PairList,
  type Pt,
  runCrossPairs,
  SHIP_PAIR_BAND,
} from "~/world/tick/broadphase";
import { createTickCtx } from "~/world/tick/context";
import {
  collideShardsShips,
  createHazardState,
  shardShipPairs,
} from "~/world/tick/hazard-collisions";
import { advanceMotion } from "~/world/tick/motion";
import {
  bulletShipPairs,
  bulletsVsShips,
  createProjectileState,
  missileShipPairs,
  missilesVsShips,
} from "~/world/tick/projectiles";
import {
  resolveShipCollisions,
  shipCollisionPairs,
} from "~/world/tick/ship-collisions";
import { ARENA, TEAMS } from "~/world/types";

const randomPts = (n: number, seed: number): Pt[] => {
  let s: Seed = seed;
  const rnd = (): number => {
    const [v, s2] = nextFloat(s);
    s = s2;
    return v;
  };
  return Array.from({ length: n }, () => ({
    x: rnd() * ARENA.w,
    y: rnd() * ARENA.h,
  }));
};

// Clone only the mutable scratch the resolver touches (world is read-only shared).
const cloneScratch = (ctx: ReturnType<typeof createTickCtx>) => ({
  ...ctx,
  moved: ctx.moved.map((s) => structuredClone(s)),
  removed: new Set(ctx.removed),
  score: { ...ctx.score },
  baseHp: { ...ctx.baseHp },
  burstAt: ctx.burstAt.map((b) => ({ ...b })),
  spawned: [...ctx.spawned],
});

// Serialize exactly the fields the resolver may mutate for a deep comparison.
const scratchSnapshot = (ctx: ReturnType<typeof createTickCtx>) =>
  JSON.stringify({
    moved: ctx.moved,
    removed: [...ctx.removed].sort((a, b) => a - b),
    score: ctx.score,
    baseHp: ctx.baseHp,
    burstAt: ctx.burstAt,
    spawned: ctx.spawned,
    seed: ctx.seed,
    nextId: ctx.nextId,
  });

// A warmed match (ships have spread and started engaging), split into the tick
// prelude (createTickCtx + advanceMotion) a collision resolver consumes.
const warmed = (seed: number, ticks = 12) => {
  let w = initWorld(seed);
  for (let i = 0; i < ticks; i++) {
    w = update({ kind: "tick", steps: 3, now: i * 100 }, w);
  }
  const ctx = createTickCtx(w, 3, 1200);
  return { ctx, motion: advanceMotion(ctx) };
};

const enemyOf = (team: string): string =>
  TEAMS.find((t) => t.name !== team)?.name ?? team;

test("gridSelfPairs matches the brute oracle exactly (set + order)", () => {
  for (const seed of [1, 2, 3, 7, 42]) {
    for (const n of [0, 1, 2, 50, 400]) {
      const pts = randomPts(n, seed);
      const grid = gridSelfPairs(pts, ARENA, SHIP_PAIR_BAND);
      const brute = bruteSelfPairs(pts, ARENA, SHIP_PAIR_BAND);
      expect(Array.from(grid)).toEqual(Array.from(brute));
    }
  }
});

test("gridSelfPairs finds clustered pairs across the toroidal seam", () => {
  // Two ships hugging opposite edges are neighbours through the wrap.
  const pts: Pt[] = [
    { x: 2, y: 135 },
    { x: ARENA.w - 2, y: 135 },
  ];
  expect(Array.from(gridSelfPairs(pts, ARENA, SHIP_PAIR_BAND))).toEqual([0, 1]);
});

test("broad-phase resolveShipCollisions is bit-identical to the nested loop", () => {
  // warmup 0 = densest (ships still packed at their bases within ±9px), stressing
  // the band margin at maximum overlap; later warmups exercise spread-out play.
  for (const seed of [1, 13, 99, 256, 2024]) {
    for (const warmup of [0, 1, 8]) {
      let w = initWorld(seed);
      for (let i = 0; i < warmup; i++) {
        w = update({ kind: "tick", steps: 3, now: i * 100 }, w);
      }
      // Reproduce the tick prelude up to the ship-collision phase.
      const ctxNested = createTickCtx(w, 3, 800);
      advanceMotion(ctxNested);
      const ctxGrid = cloneScratch(ctxNested);
      const pairs = shipCollisionPairs(ctxGrid);

      resolveShipCollisions(ctxNested); // brute nested O(n²)
      resolveShipCollisions(ctxGrid, pairs); // grid candidate list

      expect(scratchSnapshot(ctxGrid)).toBe(scratchSnapshot(ctxNested));
    }
  }
});

// --- cross-set broad-phase (bullets/missiles/shards × ships) --------------------

const CROSS_BAND = 13;

test("gridCrossPairs matches the brute oracle exactly (grouped by B, A asc)", () => {
  for (const seed of [1, 2, 7, 42]) {
    for (const [nB, nA] of [
      [0, 5],
      [5, 0],
      [3, 3],
      [40, 60],
    ]) {
      const ptsB = randomPts(nB, seed);
      const ptsA = randomPts(nA, seed + 1000);
      const grid = gridCrossPairs(ptsB, ptsA, ARENA, CROSS_BAND);
      const brute = bruteCrossPairs(ptsB, ptsA, ARENA, CROSS_BAND);
      expect(Array.from(grid)).toEqual(Array.from(brute));
    }
  }
});

// --- per-ship neighbour grid (flockSteer) --------------------------------------

test("gridNeighbors returns null when the arena is too small to grid", () => {
  // Default 480×270 field at the flock band (max engage radius) → <3 cells/axis.
  const band = Math.max(...ENGAGE_RADIUS);
  const pts = randomPts(50, 1);
  expect(gridNeighbors(pts, { w: 480, h: 270 }, band)).toBeNull();
});

// 400 ships scattered across a big (2400×1350) arena, mixed teams and levels.
const bigArenaShips = (seed: number): LightCycle[] => {
  let s: Seed = seed;
  return Array.from({ length: 400 }, (_, i) => {
    const [ship, s2] = rollShip(
      s,
      i + 1,
      ((i * 97 + 13) * seed) % 2400,
      ((i * 61 + 7) * seed) % 1350,
      1 + (i % 5),
      TEAMS[i % TEAMS.length].name,
    );
    s = s2;
    return ship;
  });
};

test("grid-neighbour flockSteer is bit-identical to the full-array scan", () => {
  const band = Math.max(...ENGAGE_RADIUS);
  const { baseHp } = initWorld(1);
  const steer = (self: LightCycle, nbr: readonly LightCycle[]) =>
    flockSteer(self, ships, [], [], baseHp, null, self.level, 0, nbr);
  let ships: LightCycle[] = [];
  setGridBounds(2400, 1350); // large arena so the grid actually engages
  try {
    let covered = 0;
    for (const seed of [1, 7, 99]) {
      ships = bigArenaShips(seed);
      const nbr = gridNeighbors(ships, { w: 2400, h: 1350 }, band);
      expect(nbr).not.toBeNull();
      if (!nbr) continue;
      for (let i = 0; i < ships.length; i++) {
        const nbrShips = nbr[i].map((j) => ships[j]);
        if (nbrShips.length > 0) covered++;
        expect(steer(ships[i], nbrShips)).toEqual(steer(ships[i], ships));
      }
    }
    expect(covered).toBeGreaterThan(0); // ships actually had neighbours
  } finally {
    setGridBounds(480, 270); // restore global arena for other tests
  }
});

test("runCrossPairs breaks a B-group on first stop but continues later groups", () => {
  // Two B groups: b=0 → a∈{1,2,3}, b=1 → a∈{4,5}. Stop b=0 at a=2.
  const pairs: PairList = new Int32Array([0, 1, 0, 2, 0, 3, 1, 4, 1, 5]);
  const seen: Array<[number, number]> = [];
  runCrossPairs(pairs, (bi, ai) => {
    seen.push([bi, ai]);
    return bi === 0 && ai === 2; // break b=0's run here
  });
  // b=0 stops after a=2 (a=3 skipped); b=1 runs fully.
  expect(seen).toEqual([
    [0, 1],
    [0, 2],
    [1, 4],
    [1, 5],
  ]);
});

test("broad-phase bulletsVsShips is bit-identical to the nested loop", () => {
  let hits = 0;
  for (const seed of [1, 13, 99, 256, 2024]) {
    const { ctx: ctxNested, motion } = warmed(seed);
    // Bolts fire only once ships engage; inject enemy bolts sitting on the first
    // few live ships (shared by both paths) so the hit/break path is exercised.
    for (let k = 0; k < Math.min(3, ctxNested.moved.length); k++) {
      const s = ctxNested.moved[k];
      motion.bullets.push({
        id: 9000 + k,
        x: s.x,
        y: s.y,
        vx: 0,
        vy: 0,
        team: enemyOf(s.colorName),
        rgb: [1, 1, 1],
        angle: 0,
        damage: 1,
        life: 120,
        owner: -1,
        bounces: 0,
        kind: 0,
      });
    }
    const ctxGrid = cloneScratch(ctxNested);
    const projNested = createProjectileState();
    const projGrid = createProjectileState();
    const pairs = bulletShipPairs(ctxGrid, motion);

    bulletsVsShips(ctxNested, motion, projNested); // nested
    bulletsVsShips(ctxGrid, motion, projGrid, pairs); // candidate list

    hits += projNested.removedBullets.size;
    expect([...projGrid.removedBullets].sort((a, b) => a - b)).toEqual(
      [...projNested.removedBullets].sort((a, b) => a - b),
    );
    expect(scratchSnapshot(ctxGrid)).toBe(scratchSnapshot(ctxNested));
  }
  expect(hits).toBeGreaterThan(0); // the hit/break path is actually exercised
});

test("broad-phase missilesVsShips is bit-identical to the nested loop", () => {
  let hits = 0;
  for (const seed of [1, 13, 99, 256, 2024]) {
    const { ctx: ctxNested, motion } = warmed(seed);
    for (let k = 0; k < Math.min(3, ctxNested.moved.length); k++) {
      const s = ctxNested.moved[k];
      motion.missiles.push({
        id: 9000 + k,
        x: s.x,
        y: s.y,
        vx: 0,
        vy: 0,
        team: enemyOf(s.colorName),
        rgb: [1, 1, 1],
        angle: 0,
        targetId: s.id,
        damage: 1,
        life: 120,
        owner: -1,
      });
    }
    const ctxGrid = cloneScratch(ctxNested);
    const projNested = createProjectileState();
    const projGrid = createProjectileState();
    const pairs = missileShipPairs(ctxGrid, motion);

    missilesVsShips(ctxNested, motion, projNested);
    missilesVsShips(ctxGrid, motion, projGrid, pairs);

    hits += projNested.removedMissiles.size;
    expect([...projGrid.removedMissiles].sort((a, b) => a - b)).toEqual(
      [...projNested.removedMissiles].sort((a, b) => a - b),
    );
    expect(scratchSnapshot(ctxGrid)).toBe(scratchSnapshot(ctxNested));
  }
  expect(hits).toBeGreaterThan(0);
});

test("broad-phase collideShardsShips is bit-identical to the nested loop", () => {
  let hits = 0;
  for (const seed of [1, 13, 99, 256, 2024]) {
    const { ctx: ctxNested, motion } = warmed(seed);
    for (let k = 0; k < Math.min(3, ctxNested.moved.length); k++) {
      const s = ctxNested.moved[k];
      motion.shards.push({
        id: 9000 + k,
        x: s.x,
        y: s.y,
        vx: 0,
        vy: 0,
        spin: 0,
        spinRate: 0,
        life: 60,
        variant: 0,
      });
    }
    const ctxGrid = cloneScratch(ctxNested);
    const hazNested = createHazardState();
    const hazGrid = createHazardState();
    const pairs = shardShipPairs(ctxGrid, motion);

    collideShardsShips(ctxNested, motion, hazNested);
    collideShardsShips(ctxGrid, motion, hazGrid, pairs);

    hits += hazNested.removedShards.size;
    expect([...hazGrid.removedShards].sort((a, b) => a - b)).toEqual(
      [...hazNested.removedShards].sort((a, b) => a - b),
    );
    expect(scratchSnapshot(ctxGrid)).toBe(scratchSnapshot(ctxNested));
  }
  expect(hits).toBeGreaterThan(0);
});
