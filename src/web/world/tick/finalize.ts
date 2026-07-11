import { cap, type EntityList, retain, spawn } from "../../engine/entities";
import { nextInt, type Seed } from "../../engine/rng";
import { EXPLOSION_VARIANTS } from "../../sprites";
import {
  EXPLOSION_DURATION,
  MAX_SHIPS,
  NUM_ASTEROIDS,
  NUM_PICKUPS,
  rollAsteroid,
  rollMany,
  rollPickup,
} from "../factory";
import type { Burst, Cmd, LightCycle, MatchConfig, World } from "../types";
import type { BurstSpec, TickCtx } from "./context";
import type { HazardState } from "./hazard-collisions";
import type { InteractionState } from "./interactions";
import type { MotionState } from "./motion";
import type { ProjectileState } from "./projectiles";

/** Spawn this tick's queued bursts, then drop any that have finished playing. */
const commitBursts = (
  base: EntityList<Burst>,
  specs: readonly BurstSpec[],
  now: number,
  seed: Seed,
): [EntityList<Burst>, Seed] => {
  let bursts = base;
  let s = seed;
  for (const b of specs) {
    const [variant, s2] = nextInt(s, EXPLOSION_VARIANTS);
    s = s2;
    bursts = spawn(bursts, (id) => ({
      id,
      x: b.x,
      y: b.y,
      start: now,
      variant,
      kind: b.kind,
      rgb: b.rgb,
      rot: b.rot,
    }));
  }
  return [retain(bursts, (b) => now - b.start < EXPLOSION_DURATION), s];
};

/** Top a survivor pool back up to `target` with seed-rolled fresh entities. */
const refillPool = <T>(
  kept: T[],
  base: number,
  target: number,
  seed: Seed,
  roll: (seed: Seed, id: number) => [T, Seed],
): [{ items: T[]; nextId: number }, Seed] => {
  const [fresh, s] = rollMany(
    Math.max(0, target - kept.length),
    seed,
    (sd, i) => roll(sd, base + i),
  );
  return [{ items: [...kept, ...fresh], nextId: base + fresh.length }, s];
};

/**
 * Once reinforcements stop, a lone surviving team wins (empty field = draw).
 * An "endless" match never decides — it runs until reset.
 */
const decideWinner = (
  current: string | null,
  nextAge: number,
  ships: readonly LightCycle[],
  config: MatchConfig,
): string | null => {
  if (config.format === "endless") return null;
  if (current !== null || nextAge < config.reinforceGens) return current;
  const teams = new Set(ships.map((s) => s.colorName));
  return teams.size <= 1 ? ([...teams][0] ?? "draw") : null;
};

const decayRally = (world: World, steps: number): World["rally"] => {
  if (!world.rally) return null;
  const ttl = world.rally.ttl - steps;
  return ttl > 0 ? { ...world.rally, ttl } : null;
};

/** The transient entity pools (shards, mines, bullets, missiles), survivors kept. */
const retainPools = (
  motion: MotionState,
  hazards: HazardState,
  interactions: InteractionState,
  projectiles: ProjectileState,
) => ({
  projectiles: {
    items: motion.shards.filter((f) => !hazards.removedShards.has(f.id)),
    nextId: motion.projId,
  },
  mines: {
    items: motion.mines.filter((m) => !interactions.removedMines.has(m.id)),
    nextId: motion.mineId,
  },
  bullets: {
    items: motion.bullets.filter((b) => !projectiles.removedBullets.has(b.id)),
    nextId: motion.bulletId,
  },
  missiles: {
    items: motion.missiles.filter(
      (m) => !projectiles.removedMissiles.has(m.id),
    ),
    nextId: motion.missileId,
  },
});

/** Commit entity pools, bursts, respawns, and match outcome after all phases. */
export const finalizeTick = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
  interactions: InteractionState,
  projectiles: ProjectileState,
): [World, Cmd[]] => {
  const { world, steps, now, spawned } = ctx;
  const survivors = ctx.moved.filter((s) => !ctx.removed.has(s.id));
  const ships = cap(
    { items: [...survivors, ...spawned], nextId: ctx.nextId },
    MAX_SHIPS,
  );
  const [bursts, sBursts] = commitBursts(
    world.bursts,
    ctx.burstAt,
    now,
    ctx.seed,
  );
  const [asteroids, sRocks] = refillPool(
    motion.rocks.filter((r) => !hazards.removedRocks.has(r.id)),
    world.asteroids.nextId,
    NUM_ASTEROIDS,
    sBursts,
    rollAsteroid,
  );
  const [pickups, seed] = refillPool(
    motion.bubbles.filter((p) => !interactions.takenPickups.has(p.id)),
    world.pickups.nextId,
    NUM_PICKUPS,
    sRocks,
    rollPickup,
  );
  const nextAge = world.age + steps;

  return [
    {
      ships,
      bursts,
      asteroids,
      pickups,
      ...retainPools(motion, hazards, interactions, projectiles),
      seed,
      score: ctx.score,
      baseHp: ctx.baseHp,
      rally: decayRally(world, steps),
      age: nextAge,
      winner: decideWinner(world.winner, nextAge, ships.items, world.config),
      config: world.config,
    },
    [],
  ];
};
