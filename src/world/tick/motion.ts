import { angleTo, easeAngle, elastic, lerp, normalize } from "~/engine/physics";
import type { PilotMods } from "~/world/augments";
import { advanceAsteroid, advanceMissile } from "~/world/factory";
import { hasArenaFurniture } from "~/world/field";
import {
  clampFieldX,
  clampFieldY,
  deltaX,
  deltaY,
  wrapX,
  wrapY,
} from "~/world/math";
import { SCROLL_RATE } from "~/world/scroll";
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

// The stick as a unit vector (zero when centred). Normalised, so a diagonal is
// not a free speed bonus in either control model.
const manualInput = (keys: World["controlKeys"]): [number, number] => {
  const ix = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const iy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (ix === 0 && iy === 0) return [0, 0];
  const len = Math.hypot(ix, iy);
  return [ix / len, iy / len];
};

/** Thrust the inertial model puts behind a fully-deflected stick. */
const MANUAL_THRUST = 3.5;

const getManualSteer = (keys: World["controlKeys"]): [number, number] => {
  const [ix, iy] = manualInput(keys);
  return [ix * MANUAL_THRUST, iy * MANUAL_THRUST];
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
    hasArenaFurniture(world),
  );
};

/** Advance one ship `steps` gens: steer, cruise-regulate, move, decay timers. */
// Where a ship lands this step. The pilot alone is walled into the field — a
// no-op on a wrapping one, so it only bites on a scroll stage, where it keeps
// them on screen (and carried along by the window) without caging the enemies.
const nextPosition = (
  s: Mutable<LightCycle>,
  world: World,
  dx: number,
  dy: number,
): { x: number; y: number } => {
  const x = wrapX(s.x + dx);
  const y = wrapY(s.y + dy);
  if (world.controlledShipId !== s.id) return { x, y };
  const r = shipRadius(s.level);
  return { x: clampFieldX(x, r), y: clampFieldY(y, r) };
};

// Where a ship is going this step: velocity plus the heading the hull points
// along (they part company only when a direct-control stick is centred).
interface Velocity {
  vx: number;
  vy: number;
  hx: number;
  hy: number;
}

/**
 * Inertial flight — every AI ship, and the pilot under the "inertial" model.
 * Steering is thrust: it bends the existing velocity, and speed is eased back
 * toward cruise every step, so a ship always carries momentum through a turn
 * and never comes to a stop.
 */
const inertialVelocity = (
  s: LightCycle,
  ax: number,
  ay: number,
  cruise: number,
  steps: number,
): Velocity => {
  const speedEase = SPEED_EASE_LVL[s.level - 1] ?? 0.08;
  const sp = Math.hypot(s.vx, s.vy) || cruise;
  const [hx, hy] = normalize(
    [s.vx + ax * steps, s.vy + ay * steps],
    [s.dx, s.dy],
  );
  const nextSp = lerp(sp, cruise, Math.min(1, speedEase * steps));
  return { vx: hx * nextSp, vy: hy * nextSp, hx, hy };
};

/**
 * Direct flight (#29) — the classic vertical shmup: the stick *is* velocity.
 * Full speed on press, dead stop on release, nothing accumulated in between.
 *
 * Two details keep "stopped" honest. The heading holds when the stick is
 * centred, so a parked hull keeps its nose where the pilot last pointed it
 * rather than snapping to a default. And on a scroll stage the window is moving
 * underneath, so stopped has to mean stopped *on screen*: a centred stick rides
 * the stage at its own rate instead of sliding off the trailing edge.
 */
const directVelocity = (
  s: LightCycle,
  world: World,
  cruise: number,
): Velocity => {
  const [ix, iy] = manualInput(world.controlKeys);
  const drift =
    world.config.format === "scroll" && !world.scrollHalted ? -SCROLL_RATE : 0;
  const still = ix === 0 && iy === 0;
  return {
    vx: ix * cruise,
    vy: iy * cruise + drift,
    hx: still ? s.dx : ix,
    hy: still ? s.dy : iy,
  };
};

/**
 * Tank after this step. A scroll stage burns nothing: it has no bases to dock
 * at and no pads to sip from, so a burning tank there is a countdown to a dead
 * engine wedged against the trailing edge of the window with no way back. Fuel
 * stays a real resource in the arena, where there is somewhere to refill it,
 * and abilities still spend it on a stage — only thrust is free.
 */
const burnFuel = (s: LightCycle, world: World, steps: number): number =>
  world.config.format === "scroll"
    ? s.fuel
    : Math.max(0, s.fuel - FUEL_BURN * steps);

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
  const piloted = world.run != null && world.controlledShipId === s.id;
  const cruise = shipCruise(s, empty) * (piloted ? mods.speedMul : 1);
  const [ax, ay] = shipAccel(s, empty, world, baseHp, neighbors, carriers);
  const manual = world.controlledShipId === s.id;
  const turnEase = manual ? 0.35 : (TURN_EASE_LVL[s.level - 1] ?? 0.14);
  // A dead engine drifts under either model — with no fuel there is no stick to
  // be direct with, so the momentum path keeps it flotsam.
  const { vx, vy, hx, hy } =
    manual && !empty && world.controlModel === "direct"
      ? directVelocity(s, world, cruise)
      : inertialVelocity(s, ax, ay, cruise, steps);
  const beamTime = s.beamActive ? s.beamTime - steps : s.beamTime;
  return {
    ...s,
    ...nextPosition(s, world, vx * steps, vy * steps),
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
    fuel: burnFuel(s, world, steps),
  };
};

/** Resolve one overlapping rock pair: elastic bounce + positional separation. */
const bounceRocks = (a: Mutable<Asteroid>, b: Mutable<Asteroid>): void => {
  const nx = deltaX(a.x, b.x);
  const ny = deltaY(a.y, b.y);
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
  a.x = wrapX(a.x - ux * overlap * aShare);
  a.y = wrapY(a.y - uy * overlap * aShare);
  b.x = wrapX(b.x + ux * overlap * bShare);
  b.y = wrapY(b.y + uy * overlap * bShare);
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
    x: wrapX(p.x + p.vx * steps),
    y: wrapY(p.y + p.vy * steps),
  }));

const advanceShards = (world: World, steps: number): Mutable<Projectile>[] =>
  world.projectiles.items
    .map((p) => ({
      ...p,
      x: wrapX(p.x + p.vx * steps),
      y: wrapY(p.y + p.vy * steps),
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
      x: wrapX(b.x + b.vx * steps),
      y: wrapY(b.y + b.vy * steps),
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
      x: wrapX(owner.x + Math.cos(phase) * r),
      y: wrapY(owner.y + Math.sin(phase) * r),
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
