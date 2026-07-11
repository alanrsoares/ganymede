import type { Seed } from "../../engine/rng";
import { nextInt } from "../../engine/rng";
import {
  baseHitsRequired,
  hurtShip,
  MATCH_REINFORCE_GENS,
  maxHpFor,
  minesFor,
  rollShip,
  SCORE_MERGE,
  shieldForLevel,
} from "../factory";
import {
  BURST_EXPLOSION,
  baseByName,
  type LightCycle,
  MAX_LEVEL,
  type Mutable,
  type Rgb,
  TEAM_BASES,
  TEAMS,
  type World,
} from "../types";

export type BurstSpec = {
  x: number;
  y: number;
  kind: number;
  rgb?: Rgb;
  rot?: number;
};

/** Mutable scratch state for one simulation tick; phases read/write this in order. */
export interface TickCtx {
  readonly steps: number;
  readonly now: number;
  readonly world: World;
  readonly suddenDeath: boolean;

  moved: Mutable<LightCycle>[];
  seed: Seed;
  nextId: number;
  score: Record<string, number>;
  baseHp: Record<string, number>;
  spawned: LightCycle[];
  burstAt: BurstSpec[];
  removed: Set<number>;
}

export const createTickCtx = (
  world: World,
  steps: number,
  now: number,
): TickCtx => ({
  steps,
  now,
  world,
  suddenDeath: world.age >= MATCH_REINFORCE_GENS,
  moved: [],
  seed: world.seed,
  nextId: world.ships.nextId,
  score: { ...world.score },
  baseHp: { ...world.baseHp },
  spawned: [],
  burstAt: [],
  removed: new Set<number>(),
});

export const replace = (ctx: TickCtx) => {
  if (ctx.suddenDeath) return;
  const alive = TEAMS.filter((t) => ctx.baseHp[t.name] > 0);
  if (alive.length === 0) return;
  const [pick, s0] = nextInt(ctx.seed, alive.length);
  ctx.seed = s0;
  const [ship, s2] = rollShip(ctx.seed, ctx.nextId, 0, 0, 1, alive[pick].name);
  const base = baseByName.get(ship.colorName);
  ctx.spawned.push(base ? { ...ship, x: base.x, y: base.y } : ship);
  ctx.seed = s2;
  ctx.nextId += 1;
};

export const killShip = (ctx: TickCtx, s: Mutable<LightCycle>) => {
  ctx.burstAt.push({
    x: Math.floor(s.x),
    y: Math.floor(s.y),
    kind: BURST_EXPLOSION,
  });
  ctx.removed.add(s.id);
  replace(ctx);
};

export const hit = (_ctx: TickCtx, s: Mutable<LightCycle>, amt: number) => {
  if (s.invulnTime > 0) return;
  hurtShip(s, amt);
};

/** True once `s` has hit every alive enemy base at least `need` times. */
const enemyBasesFullyRaided = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  need: number,
): boolean => {
  let aliveEnemyBases = 0;
  for (const base of TEAM_BASES) {
    if (base.name === s.colorName || ctx.baseHp[base.name] <= 0) continue;
    aliveEnemyBases += 1;
    if ((s.baseHits[base.name] ?? 0) < need) return false; // still owe hits
  }
  return aliveEnemyBases > 0; // false if there's nothing left to raid
};

/**
 * Credit a base-raid hit to the shooter (looked up by id). When it has hit every
 * alive enemy base the required number of times, it levels up and the tally
 * resets — the higher the rank, the more hits the next level demands.
 */
export const creditBaseHit = (
  ctx: TickCtx,
  ownerId: number,
  baseName: string,
) => {
  const s = ctx.moved.find((m) => m.id === ownerId && !ctx.removed.has(m.id));
  if (!s || s.level >= MAX_LEVEL) return;
  s.baseHits = { ...s.baseHits, [baseName]: (s.baseHits[baseName] ?? 0) + 1 };
  if (!enemyBasesFullyRaided(ctx, s, baseHitsRequired(s.level))) return;
  promote(ctx, s);
  s.baseHits = {};
};

export const promote = (ctx: TickCtx, s: Mutable<LightCycle>) => {
  if (s.level >= MAX_LEVEL) return;
  s.level += 1;
  s.maxHp = maxHpFor(s.archetype, s.level);
  s.hp = s.maxHp;
  s.maxShield = shieldForLevel(s.level);
  s.shield = s.maxShield;
  s.maxMines = minesFor(s.archetype, s.level);
  s.mines = s.maxMines;
  ctx.score[s.colorName] += SCORE_MERGE;
  ctx.burstAt.push({
    x: Math.floor(s.x),
    y: Math.floor(s.y),
    kind: BURST_EXPLOSION,
  });
};
