import {
  angleTo,
  easeAngle,
  elastic,
  lerp,
  normalize,
  wrapDelta,
} from "~/engine/physics";
import type { PilotMods } from "~/world/augments";
import { advanceAsteroid, advanceMissile } from "~/world/factory";
import { wrap } from "~/world/math";
import { flockSteer, fuelCarriers } from "~/world/steering";
import {
  BOOST_MULT,
  cruiseFor,
  DRONE_ORBIT_RADIUS,
  DRONE_ORBIT_SPEED,
  ENGAGE_RADIUS,
  FUEL_BURN,
  FUEL_DRIFT_SPEED,
  regenForLevel,
  SPEED_EASE_LVL,
  shipRadius,
  TURN_EASE_LVL,
} from "~/world/tuning";
import {
  ARENA,
  type Asteroid,
  type Bullet,
  type Drone,
  type LightCycle,
  type Mine,
  type Missile,
  type Mutable,
  type Pickup,
  type Projectile,
  type World,
} from "~/world/types";
import { gridNeighbors } from "./broadphase";
import type { TickCtx } from "./context";

export interface MotionState {
  rocks: Mutable<Asteroid>[];
  bubbles: Mutable<Pickup>[];
  shards: Mutable<Projectile>[];
  mines: Mutable<Mine>[];
  bullets: Mutable<Bullet>[];
  missiles: Mutable<Missile>[];
  drones: Mutable<Drone>[];
  projId: number;
  mineId: number;
  bulletId: number;
  missileId: number;
}

type BaseHp = Readonly<Record<string, number>>;

// Broad-phase cell band for flock neighbour queries = the widest per-ship range
// term (max engage radius). Every flock term re-gates to its own smaller radius.
const FLOCK_BAND = Math.max(...ENGAGE_RADIUS);

/** Cruise speed target: dead engine drifts slowly; else per-class cruise × boost. */
const shipCruise = (s: LightCycle, empty: boolean): number =>
  empty
    ? FUEL_DRIFT_SPEED
    : cruiseFor(s.archetype, s.level) * (s.boostTime > 0 ? BOOST_MULT : 1);

const getManualSteer = (keys: World["controlKeys"]): [number, number] => {
  const ix = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const iy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (ix === 0 && iy === 0) return [0, 0];
  const len = Math.hypot(ix, iy);
  const force = 3.5;
  return [(ix / len) * force, (iy / len) * force];
};

/** Steering acceleration: none when out of fuel, else the flocking/AI steer. */
const shipAccel = (
  s: LightCycle,
  empty: boolean,
  world: World,
  baseHp: BaseHp,
  neighbors: readonly LightCycle[],
  carriers: readonly LightCycle[],
): [number, number] => {
  if (empty) return [0, 0];
  if (world.controlledShipId === s.id) {
    return getManualSteer(world.controlKeys);
  }
  return flockSteer(
    s,
    world.ships.items,
    world.asteroids.items,
    world.pickups.items,
    baseHp,
    world.rally,
    s.level,
    world.age,
    neighbors,
    carriers,
  );
};

/** Advance one ship `steps` gens: steer, cruise-regulate, move, decay timers. */
const advanceShip = (
  s: LightCycle,
  world: World,
  mods: PilotMods,
  baseHp: BaseHp,
  steps: number,
  neighbors: readonly LightCycle[],
  carriers: readonly LightCycle[],
): Mutable<LightCycle> => {
  // Out of fuel = dead engine: no thrust, just a slow aimless drift like a
  // power-up orb — defenseless flotsam until it's tugged home or picked off.
  const empty = s.fuel <= 0;
  // Only the piloted arcade ship carries the run's speed/regen mods; everyone
  // else (and all of autobattle) advances at 1×.
  const piloted = world.arcade != null && world.controlledShipId === s.id;
  const cruise = shipCruise(s, empty) * (piloted ? mods.speedMul : 1);
  const [ax, ay] = shipAccel(s, empty, world, baseHp, neighbors, carriers);
  const bvx = s.vx + ax * steps;
  const bvy = s.vy + ay * steps;
  const speedEase = SPEED_EASE_LVL[s.level - 1] ?? 0.08;
  const turnEase =
    world.controlledShipId === s.id
      ? 0.35
      : (TURN_EASE_LVL[s.level - 1] ?? 0.14);
  const sp = Math.hypot(s.vx, s.vy) || cruise;
  const [hx, hy] = normalize([bvx, bvy], [s.dx, s.dy]);
  const nextSp = lerp(sp, cruise, Math.min(1, speedEase * steps));
  const vx = hx * nextSp;
  const vy = hy * nextSp;
  const beamTime = s.beamActive ? s.beamTime - steps : s.beamTime;
  return {
    ...s,
    x: wrap(s.x + vx * steps, ARENA.w),
    y: wrap(s.y + vy * steps, ARENA.h),
    vx,
    vy,
    dx: hx,
    dy: hy,
    angle: easeAngle(s.angle, angleTo([hx, hy]), Math.min(1, turnEase * steps)),
    beamTime,
    beamActive: s.beamActive && beamTime > 0,
    hitCooldown: Math.max(0, s.hitCooldown - steps),
    hitFlash: Math.max(0, s.hitFlash - steps),
    overchargeTime: Math.max(0, s.overchargeTime - steps),
    invulnTime: Math.max(0, s.invulnTime - steps),
    forceFieldTime: Math.max(0, s.forceFieldTime - steps),
    hp: Math.min(
      s.maxHp,
      s.hp + regenForLevel(s.level) * (piloted ? mods.regenMul : 1) * steps,
    ),
    boostTime: Math.max(0, s.boostTime - steps),
    portalCooldown: Math.max(0, s.portalCooldown - steps),
    fireCooldown: Math.max(0, s.fireCooldown - steps),
    fuel: Math.max(0, s.fuel - FUEL_BURN * steps),
  };
};

/** Resolve one overlapping rock pair: elastic bounce + positional separation. */
const bounceRocks = (a: Mutable<Asteroid>, b: Mutable<Asteroid>): void => {
  const nx = wrapDelta(a.x, b.x, ARENA.w);
  const ny = wrapDelta(a.y, b.y, ARENA.h);
  const rad = a.size + b.size;
  const dist = Math.hypot(nx, ny);
  if (dist >= rad || dist < 1e-3) return;
  const ma = a.size * 3;
  const mb = b.size * 3;
  const [av, bv] = elastic([a.vx, a.vy], [b.vx, b.vy], [nx, ny], ma, mb);
  a.vx = av[0];
  a.vy = av[1];
  b.vx = bv[0];
  b.vy = bv[1];
  const ux = nx / dist;
  const uy = ny / dist;
  const overlap = rad - dist;
  const aShare = mb / (ma + mb);
  const bShare = ma / (ma + mb);
  a.x = wrap(a.x - ux * overlap * aShare, ARENA.w);
  a.y = wrap(a.y - uy * overlap * aShare, ARENA.h);
  b.x = wrap(b.x + ux * overlap * bShare, ARENA.w);
  b.y = wrap(b.y + uy * overlap * bShare, ARENA.h);
};

/** Pairwise asteroid collisions (O(n²); n = NUM_ASTEROIDS is small). */
const collideRocks = (rocks: Mutable<Asteroid>[]): void => {
  for (let i = 0; i < rocks.length; i++) {
    for (let j = i + 1; j < rocks.length; j++) bounceRocks(rocks[i], rocks[j]);
  }
};

const advanceBubbles = (world: World, steps: number): Mutable<Pickup>[] =>
  world.pickups.items.map((p) => ({
    ...p,
    x: wrap(p.x + p.vx * steps, ARENA.w),
    y: wrap(p.y + p.vy * steps, ARENA.h),
  }));

const advanceShards = (world: World, steps: number): Mutable<Projectile>[] =>
  world.projectiles.items
    .map((p) => ({
      ...p,
      x: wrap(p.x + p.vx * steps, ARENA.w),
      y: wrap(p.y + p.vy * steps, ARENA.h),
      spin: p.spin + p.spinRate * steps,
      life: p.life - steps,
    }))
    .filter((p) => p.life > 0);

const advanceMines = (world: World, steps: number): Mutable<Mine>[] =>
  world.mines.items
    .map((m) => ({
      ...m,
      arm: Math.max(0, m.arm - steps),
      life: m.life - steps,
      spin: m.spin + m.spinRate * steps,
    }))
    .filter((m) => m.life > 0);

const advanceBullets = (world: World, steps: number): Mutable<Bullet>[] =>
  world.bullets.items
    .map((b) => ({
      ...b,
      x: wrap(b.x + b.vx * steps, ARENA.w),
      y: wrap(b.y + b.vy * steps, ARENA.h),
      life: b.life - steps,
    }))
    .filter((b) => b.life > 0);

const advanceMissiles = (
  world: World,
  shipById: Map<number, Mutable<LightCycle>>,
  steps: number,
): Mutable<Missile>[] =>
  world.missiles.items
    .map((m) => ({ ...advanceMissile(m, shipById.get(m.targetId), steps) }))
    .filter((m) => m.life > 0);

// Escort drones ride their owner: re-anchor to the (moved) owner each gen on an
// orbit ring, tick down life + fire cooldown, and dissipate when the timer runs
// out or the owner is gone. Firing itself happens in resolveInteractions.
const advanceDrones = (
  drones: readonly Drone[],
  shipById: Map<number, Mutable<LightCycle>>,
  steps: number,
): Mutable<Drone>[] => {
  const out: Mutable<Drone>[] = [];
  for (const d of drones) {
    const owner = shipById.get(d.ownerId);
    if (!owner) continue; // owner gone → drone dissipates
    const life = d.life - steps;
    if (life <= 0) continue;
    const phase = d.phase + DRONE_ORBIT_SPEED * steps;
    const r = shipRadius(owner.level) + DRONE_ORBIT_RADIUS;
    out.push({
      ...d,
      phase,
      x: wrap(owner.x + Math.cos(phase) * r, ARENA.w),
      y: wrap(owner.y + Math.sin(phase) * r, ARENA.h),
      life,
      fireCooldown: Math.max(0, d.fireCooldown - steps),
    });
  }
  return out;
};

/** Advance every entity for `steps` generations; returns mutable copies for collision. */
export const advanceMotion = (ctx: TickCtx): MotionState => {
  const { world, steps } = ctx;

  // Broad-phase the range-limited flock terms: one grid over ship positions at
  // the max engage radius. Returns null (→ brute full-array scan) when the arena
  // is too small to grid, e.g. the default 480×270 field — so behaviour there is
  // unchanged; the grid only engages in the large arenas high ship counts need.
  const ships = world.ships.items;
  const nbr = gridNeighbors(ships, ARENA, FLOCK_BAND);
  // Pre-filter fuel-capable carriers once so each ship's nearest-fuel-source scan
  // is O(carriers) instead of O(ships) (carriers ≪ ships) — the last O(n²) term.
  const carriers = fuelCarriers(ships);
  ctx.moved = ships.map((s, i) =>
    advanceShip(
      s,
      world,
      ctx.mods,
      ctx.baseHp,
      steps,
      nbr ? nbr[i].map((j) => ships[j]) : ships,
      carriers,
    ),
  );

  const rocks: Mutable<Asteroid>[] = world.asteroids.items.map((a) => ({
    ...advanceAsteroid(a, steps),
  }));
  collideRocks(rocks);

  const shipById = new Map(ctx.moved.map((s) => [s.id, s]));

  return {
    rocks,
    bubbles: advanceBubbles(world, steps),
    shards: advanceShards(world, steps),
    mines: advanceMines(world, steps),
    bullets: advanceBullets(world, steps),
    missiles: advanceMissiles(world, shipById, steps),
    drones: advanceDrones(world.drones.items, shipById, steps),
    projId: world.projectiles.nextId,
    mineId: world.mines.nextId,
    bulletId: world.bullets.nextId,
    missileId: world.missiles.nextId,
  };
};
