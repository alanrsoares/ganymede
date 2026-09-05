import { capExcept, type EntityList, retain, spawn } from "~/engine/entities";
import { nextInt, type Seed } from "~/engine/rng";
import { rollAsteroid, rollMany, rollPickup } from "~/world/factory";
import { resolveLock } from "~/world/lock";
import { inField } from "~/world/math";
import {
  EXPLOSION_DURATION,
  EXPLOSION_VARIANTS,
  MAX_ARCADE_SHIPS,
  MAX_SHIPS,
  NUM_ASTEROIDS,
  NUM_PICKUPS,
} from "~/world/tuning";
import {
  ARCADE_PICKUP_KINDS,
  type Asteroid,
  type Burst,
  type Drone,
  type LightCycle,
  type MatchConfig,
  PICKUP_KINDS,
  type Pickup,
  type World,
} from "~/world/types";
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
      x2: b.x2,
      y2: b.y2,
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
  if (config.format !== "standard") return null; // endless/arcade never decide
  if (current !== null || nextAge < config.reinforceGens) return current;
  const teams = new Set(ships.map((s) => s.colorName));
  return teams.size <= 1 ? ([...teams][0] ?? "draw") : null;
};

const decayRally = (world: World, steps: number): World["rally"] => {
  if (!world.rally) return null;
  const ttl = world.rally.ttl - steps;
  return ttl > 0 ? { ...world.rally, ttl } : null;
};

// One cull rule for the whole world: anything that has drifted out of the
// inflated field rect is gone. On a torus `inField` is always true, so every
// filter below is a no-op for autobattle and arcade — the scroll stage is the
// only topology with an outside to fall off.
const onField = <T extends { x: number; y: number }>(e: T): boolean =>
  inField(e.x, e.y);

/** The transient entity pools (shards, mines, bullets, missiles), survivors kept. */
const retainPools = (
  motion: MotionState,
  hazards: HazardState,
  interactions: InteractionState,
  projectiles: ProjectileState,
) => ({
  projectiles: {
    items: motion.shards.filter(
      (f) => !hazards.removedShards.has(f.id) && onField(f),
    ),
    nextId: motion.projId,
  },
  mines: {
    items: motion.mines.filter(
      (m) => !interactions.removedMines.has(m.id) && onField(m),
    ),
    nextId: motion.mineId,
  },
  bullets: {
    items: motion.bullets.filter(
      (b) => !projectiles.removedBullets.has(b.id) && onField(b),
    ),
    nextId: motion.bulletId,
  },
  missiles: {
    items: motion.missiles.filter(
      (m) => !projectiles.removedMissiles.has(m.id) && onField(m),
    ),
    nextId: motion.missileId,
  },
});

// Commit escort drones: motion advanced/expired the existing ones; new ones
// queued by drone pickups get their ids here. Any whose owner died this tick drop.
const commitDrones = (ctx: TickCtx, motion: MotionState): EntityList<Drone> => {
  const base = ctx.world.drones.nextId;
  const fresh = ctx.spawnedDrones.map((d, i) => ({ ...d, id: base + i }));
  return {
    items: [...motion.drones, ...fresh].filter(
      (d) => !ctx.removed.has(d.ownerId) && onField(d),
    ),
    nextId: base + fresh.length,
  };
};

// Ships the trim must never evict: the piloted ship and (in arcade) any
// player-team ship, summons included — trimming one reads downstream as a death.
const trimProtected =
  (world: World) =>
  (s: LightCycle): boolean =>
    s.id === world.controlledShipId ||
    (world.config.run?.playerTeam !== undefined &&
      s.colorName === world.config.run.playerTeam);

// Scenery culls and refills through one pool per kind: a rock or bubble that
// falls behind the camera is replaced by one rolled onto the live field's edge,
// which is spawn-ahead for free (see rollAsteroid). On a torus nothing is ever
// culled, so both pools behave exactly as they always have.
const commitScenery = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
  interactions: InteractionState,
  seed0: Seed,
): [{ asteroids: EntityList<Asteroid>; pickups: EntityList<Pickup> }, Seed] => {
  const { world } = ctx;
  const [asteroids, sRocks] = refillPool(
    motion.rocks.filter((r) => !hazards.removedRocks.has(r.id) && onField(r)),
    world.asteroids.nextId,
    NUM_ASTEROIDS,
    seed0,
    rollAsteroid,
  );
  // A piloted run adds the muster kind (9) to the pool; autobattle keeps kinds
  // 0..8, so its pickup rolls — and the golden characterization — are unchanged.
  const pickupKinds = world.run ? ARCADE_PICKUP_KINDS : PICKUP_KINDS;
  const [pickups, seed] = refillPool(
    motion.bubbles.filter(
      (p) => !interactions.takenPickups.has(p.id) && onField(p),
    ),
    world.pickups.nextId,
    NUM_PICKUPS,
    sRocks,
    (sd, id) => rollPickup(sd, id, pickupKinds),
  );
  return [{ asteroids, pickups }, seed];
};

/** Commit entity pools, bursts, respawns, and match outcome after all phases. */
export const finalizeTick = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
  interactions: InteractionState,
  projectiles: ProjectileState,
): World => {
  const { world, steps, now, spawned } = ctx;
  // Ships that have left the field are gone too — except the ones the trim
  // protects, since deleting the pilot reads downstream as a death.
  const keep = trimProtected(world);
  const survivors = ctx.moved.filter(
    (s) => !ctx.removed.has(s.id) && (onField(s) || keep(s)),
  );
  // A piloted run gets a bigger array cap and never evicts the pilot or its
  // player-team summons; autobattle keeps MAX_SHIPS (matches `cap` with no
  // controlled ship).
  const ships = capExcept(
    { items: [...survivors, ...spawned], nextId: ctx.nextId },
    world.run ? MAX_ARCADE_SHIPS : MAX_SHIPS,
    trimProtected(world),
  );
  const [bursts, sBursts] = commitBursts(
    world.bursts,
    ctx.burstAt,
    now,
    ctx.seed,
  );
  const [{ asteroids, pickups }, seed] = commitScenery(
    ctx,
    motion,
    hazards,
    interactions,
    sBursts,
  );
  const nextAge = world.age + steps;

  return {
    ships,
    bursts,
    asteroids,
    pickups,
    drones: commitDrones(ctx, motion),
    ...retainPools(motion, hazards, interactions, projectiles),
    seed,
    score: ctx.score,
    baseHp: ctx.baseHp,
    rally: decayRally(world, steps),
    age: nextAge,
    winner: decideWinner(world.winner, nextAge, ships.items, world.config),
    config: world.config,
    run: world.run,
    // The stage was advanced before the tick ran (see world/scroll.ts), so this
    // carries that position forward rather than deriving a new one.
    scrollY: world.scrollY,
    scrollHalted: world.scrollHalted,
    controlledShipId: world.controlledShipId,
    lockedTargetId: resolveLock(world, ships),
    controlKeys: world.controlKeys,
  };
};
