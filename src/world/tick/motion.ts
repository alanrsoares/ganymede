import {
  angleTo,
  easeAngle,
  elastic,
  normalize,
  wrapDelta,
} from "~/engine/physics";
import {
  advanceAsteroid,
  advanceMissile,
  BOOST_MULT,
  cruiseFor,
  FUEL_BURN,
  FUEL_DRIFT_SPEED,
  flockSteer,
  regenForLevel,
  SPEED_EASE_LVL,
  TURN_EASE_LVL,
  wrap,
} from "../factory";
import {
  type Asteroid,
  type Bullet,
  GRID_H,
  GRID_W,
  type LightCycle,
  type Mine,
  type Missile,
  type Mutable,
  type Pickup,
  type Projectile,
  type World,
} from "../types";
import type { TickCtx } from "./context";

export interface MotionState {
  rocks: Mutable<Asteroid>[];
  bubbles: Mutable<Pickup>[];
  shards: Mutable<Projectile>[];
  mines: Mutable<Mine>[];
  bullets: Mutable<Bullet>[];
  missiles: Mutable<Missile>[];
  projId: number;
  mineId: number;
  bulletId: number;
  missileId: number;
}

type BaseHp = Readonly<Record<string, number>>;

/** Cruise speed target: dead engine drifts slowly; else per-class cruise × boost. */
const shipCruise = (s: LightCycle, empty: boolean): number =>
  empty
    ? FUEL_DRIFT_SPEED
    : cruiseFor(s.archetype, s.level) * (s.boostTime > 0 ? BOOST_MULT : 1);

/** Steering acceleration: none when out of fuel, else the flocking/AI steer. */
const shipAccel = (
  s: LightCycle,
  empty: boolean,
  world: World,
  baseHp: BaseHp,
): [number, number] =>
  empty
    ? [0, 0]
    : flockSteer(
      s,
      world.ships.items,
      world.asteroids.items,
      world.pickups.items,
      baseHp,
      world.rally,
      s.level,
      world.age,
    );

/** Advance one ship `steps` gens: steer, cruise-regulate, move, decay timers. */
const advanceShip = (
  s: LightCycle,
  world: World,
  baseHp: BaseHp,
  steps: number,
): Mutable<LightCycle> => {
  // Out of fuel = dead engine: no thrust, just a slow aimless drift like a
  // power-up orb — defenseless flotsam until it's tugged home or picked off.
  const empty = s.fuel <= 0;
  const cruise = shipCruise(s, empty);
  const [ax, ay] = shipAccel(s, empty, world, baseHp);
  const bvx = s.vx + ax * steps;
  const bvy = s.vy + ay * steps;
  const speedEase = SPEED_EASE_LVL[s.level - 1] ?? 0.08;
  const turnEase = TURN_EASE_LVL[s.level - 1] ?? 0.14;
  const sp = Math.hypot(s.vx, s.vy) || cruise;
  const [hx, hy] = normalize([bvx, bvy], [s.dx, s.dy]);
  const nextSp = sp + (cruise - sp) * Math.min(1, speedEase * steps);
  const vx = hx * nextSp;
  const vy = hy * nextSp;
  const beamTime = s.beamActive ? s.beamTime - steps : s.beamTime;
  return {
    ...s,
    x: wrap(s.x + vx * steps, GRID_W),
    y: wrap(s.y + vy * steps, GRID_H),
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
    hp: Math.min(s.maxHp, s.hp + regenForLevel(s.level) * steps),
    boostTime: Math.max(0, s.boostTime - steps),
    portalCooldown: Math.max(0, s.portalCooldown - steps),
    fireCooldown: Math.max(0, s.fireCooldown - steps),
    fuel: Math.max(0, s.fuel - FUEL_BURN * steps),
  };
};

/** Resolve one overlapping rock pair: elastic bounce + positional separation. */
const bounceRocks = (a: Mutable<Asteroid>, b: Mutable<Asteroid>): void => {
  const nx = wrapDelta(a.x, b.x, GRID_W);
  const ny = wrapDelta(a.y, b.y, GRID_H);
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
  a.x = wrap(a.x - ux * overlap * aShare, GRID_W);
  a.y = wrap(a.y - uy * overlap * aShare, GRID_H);
  b.x = wrap(b.x + ux * overlap * bShare, GRID_W);
  b.y = wrap(b.y + uy * overlap * bShare, GRID_H);
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
    x: wrap(p.x + p.vx * steps, GRID_W),
    y: wrap(p.y + p.vy * steps, GRID_H),
  }));

const advanceShards = (world: World, steps: number): Mutable<Projectile>[] =>
  world.projectiles.items
    .map((p) => ({
      ...p,
      x: wrap(p.x + p.vx * steps, GRID_W),
      y: wrap(p.y + p.vy * steps, GRID_H),
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
      x: wrap(b.x + b.vx * steps, GRID_W),
      y: wrap(b.y + b.vy * steps, GRID_H),
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

/** Advance every entity for `steps` generations; returns mutable copies for collision. */
export const advanceMotion = (ctx: TickCtx): MotionState => {
  const { world, steps } = ctx;

  ctx.moved = world.ships.items.map((s) =>
    advanceShip(s, world, ctx.baseHp, steps),
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
    projId: world.projectiles.nextId,
    mineId: world.mines.nextId,
    bulletId: world.bullets.nextId,
    missileId: world.missiles.nextId,
  };
};
