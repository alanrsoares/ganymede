// Sim-tick scaling bench. Measures how the tick pipeline cost grows with ship
// count and attributes it per phase — the harness used to drive the broad-phase
// work in src/world/tick/broadphase.ts.
//
// USAGE: `finalize` caps ships to MAX_SHIPS every tick, so to measure high counts
// you must temporarily raise it:
//   1. edit src/world/tuning.ts → `export const MAX_SHIPS = 100000;`
//   2. `bun run scripts/scale-bench.ts`
//   3. revert MAX_SHIPS to 12.
// The arena is scaled with n (fixed realistic density, setGridBounds) so ships
// survive instead of instantly overlapping. At the shipped cap (12) the O(n²)
// terms are trivial and this bench is a no-op (ships collapse to 12).
import type { Seed } from "~/engine/rng";
import {
  ARENA,
  initWorld,
  setGridBounds,
  TEAMS,
  update,
  type World,
} from "~/world";
import { rollShip } from "~/world/factory";
import { createTickCtx } from "~/world/tick/context";
import { finalizeTick } from "~/world/tick/finalize";
import {
  createHazardState,
  resolveHazardCollisions,
} from "~/world/tick/hazard-collisions";
import {
  createInteractionState,
  resolveFieldEffects,
  resolveInteractions,
} from "~/world/tick/interactions";
import { advanceMotion } from "~/world/tick/motion";
import {
  createProjectileState,
  resolveProjectiles,
} from "~/world/tick/projectiles";
import {
  resolveShipCollisions,
  shipCollisionPairs,
} from "~/world/tick/ship-collisions";

const DENSITY = 10800; // px² per ship (the real 480×270 arena / 12 ships)

// Size the toroidal arena to n ships at a fixed density, 16:9.
const sizeArena = (n: number): void => {
  const area = n * DENSITY;
  const w = Math.round(Math.sqrt((area * 16) / 9));
  setGridBounds(w, Math.round(area / w));
};

// N ships on an even grid (uniform density, minimal instant overlap), mixed teams
// and levels, spread across the current ARENA.
const scatter = (n: number, seed: number): World => {
  const w = initWorld(seed);
  let s: Seed = seed;
  const cols = Math.max(1, Math.round(Math.sqrt((n * ARENA.w) / ARENA.h)));
  const rows = Math.ceil(n / cols);
  const dx = ARENA.w / cols;
  const dy = ARENA.h / rows;
  const items = [];
  for (let i = 0; i < n; i++) {
    const x = ((i % cols) + 0.5) * dx;
    const y = (Math.floor(i / cols) + 0.5) * dy;
    const team = TEAMS[i % TEAMS.length].name;
    const [ship, s2] = rollShip(s, i + 1, x, y, 1 + (i % 5), team);
    s = s2;
    items.push(ship);
  }
  return { ...w, ships: { items, nextId: n + 1 } };
};

const timeTicks = (
  w0: World,
  k: number,
): { msPerTick: number; endN: number } => {
  let w = w0;
  const t0 = performance.now();
  for (let i = 0; i < k; i++)
    w = update({ kind: "tick", steps: 3, now: i * 100 }, w);
  return {
    msPerTick: (performance.now() - t0) / k,
    endN: w.ships.items.length,
  };
};

const SIZES = [100, 250, 500, 1000, 2000, 4000, 8000];
const WARMUP = 3;
const TIMED = 15;

console.log(`density ${DENSITY}px²/ship, steps=3, ${TIMED} timed ticks\n`);
console.log("    n |   arena   |  ms/tick |  µs/ship |  endN | exponent");
console.log("------|-----------|----------|----------|-------|---------");
let prev: { n: number; ms: number } | null = null;
for (const n of SIZES) {
  sizeArena(n);
  const arenaStr = `${ARENA.w}×${ARENA.h}`;
  let w = scatter(n, 1234);
  for (let i = 0; i < WARMUP; i++)
    w = update({ kind: "tick", steps: 3, now: -1000 + i }, w);
  const { msPerTick, endN } = timeTicks(w, TIMED);
  const usPerShip = (msPerTick * 1000) / n;
  const exp = prev
    ? (Math.log(msPerTick / prev.ms) / Math.log(n / prev.n)).toFixed(2)
    : "—";
  console.log(
    `${String(n).padStart(5)} | ${arenaStr.padStart(9)} | ${msPerTick.toFixed(3).padStart(8)} | ${usPerShip.toFixed(3).padStart(8)} | ${String(endN).padStart(5)} | ${exp.padStart(7)}`,
  );
  prev = { n, ms: msPerTick };
}

// Per-phase attribution at n=2000: replay tick()'s phases in order, timing each.
const breakdown = (n: number): void => {
  sizeArena(n);
  const w = scatter(n, 1234);
  const t: Record<string, number> = {};
  const mark = <T>(k: string, fn: () => T): T => {
    const t0 = performance.now();
    const r = fn();
    t[k] = performance.now() - t0;
    return r;
  };
  const ctx = createTickCtx(w, 3, 0);
  const motion = mark("motion+flock", () => advanceMotion(ctx));
  const haz = createHazardState();
  const inter = createInteractionState();
  const proj = createProjectileState();
  mark("shipCollisions", () =>
    resolveShipCollisions(ctx, shipCollisionPairs(ctx)),
  );
  mark("hazards", () => resolveHazardCollisions(ctx, motion, haz));
  mark("interactions", () => resolveInteractions(ctx, motion, inter));
  mark("fieldEffects", () => resolveFieldEffects(ctx, motion, inter, haz));
  mark("projectiles", () => resolveProjectiles(ctx, motion, haz, proj));
  mark("finalize", () => finalizeTick(ctx, motion, haz, inter, proj));
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  console.log(`\nphase breakdown @n=${n} (single tick, ms):`);
  for (const [k, v] of Object.entries(t))
    console.log(
      `  ${k.padEnd(16)} ${v.toFixed(2).padStart(8)}  ${String(Math.round((100 * v) / total)).padStart(3)}%`,
    );
};
breakdown(2000);

// Determinism spot-check at n=1000.
sizeArena(1000);
const run = (): string => {
  let w = scatter(1000, 4242);
  for (let i = 0; i < 20; i++)
    w = update({ kind: "tick", steps: 3, now: i * 100 }, w);
  return JSON.stringify(w);
};
const [d1, d2] = [run(), run()];
console.log(`\ndeterministic @n=1000: ${d1 === d2}`);
