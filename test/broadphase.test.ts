// CPU broad-phase (src/world/tick/broadphase) validation. Two layers:
//   1. the grid enumerator produces exactly the brute oracle's pair set/order;
//   2. feeding that candidate list to resolveShipCollisions yields a world
//      bit-identical to the untouched nested O(n²) loop — the seam that a GPU
//      pair list will later drop into.
import { expect, test } from "bun:test";
import { nextFloat, type Seed } from "~/engine/rng";
import { initWorld, update } from "~/world";
import {
  bruteCrossPairs,
  bruteSelfPairs,
  gridCrossPairs,
  gridSelfPairs,
  type PairList,
  type Pt,
  runCrossPairs,
  SHIP_PAIR_BAND,
} from "~/world/tick/broadphase";
import { createTickCtx } from "~/world/tick/context";
import { advanceMotion } from "~/world/tick/motion";
import {
  bulletShipPairs,
  bulletsVsShips,
  createProjectileState,
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
    let w = initWorld(seed);
    for (let i = 0; i < 12; i++) {
      w = update({ kind: "tick", steps: 3, now: i * 100 }, w);
    }
    const ctxNested = createTickCtx(w, 3, 1200);
    const motion = advanceMotion(ctxNested);
    // Bolts fire only once ships engage; inject enemy bolts sitting on the first
    // few live ships (shared by both paths) so the hit/break path is exercised.
    const enemyTeam = (team: string) =>
      TEAMS.find((t) => t.name !== team)?.name ?? team;
    for (let k = 0; k < Math.min(3, ctxNested.moved.length); k++) {
      const s = ctxNested.moved[k];
      motion.bullets.push({
        id: 9000 + k,
        x: s.x,
        y: s.y,
        vx: 0,
        vy: 0,
        team: enemyTeam(s.colorName),
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
