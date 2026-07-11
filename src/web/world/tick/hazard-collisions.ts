import { elastic, normalize, wrapDelta } from "../../engine/physics";
import {
  BASE_RADIUS,
  BASE_RAM_DAMAGE,
  HIT_COOLDOWN,
  SHRAPNEL_RADIUS,
  shipRadius,
  spawnShrapnel,
  toroidalDist,
  wrap,
} from "../factory";
import {
  type Asteroid,
  type Base,
  BURST_EXPLOSION,
  BURST_IMPACT,
  GRID_H,
  GRID_W,
  type LightCycle,
  type Mutable,
  type Projectile,
  TEAM_BASES,
} from "../types";
import { hit, killShip, type TickCtx } from "./context";
import type { MotionState } from "./motion";

export interface HazardState {
  removedRocks: Set<number>;
  removedShards: Set<number>;
}

export const createHazardState = (): HazardState => ({
  removedRocks: new Set<number>(),
  removedShards: new Set<number>(),
});

type Ship = Mutable<LightCycle>;
type Rock = Mutable<Asteroid>;
type Step = "break" | "next"; // loop control returned by a pair handler

/** Damage a team base by a ram and flag the impact FX (clamped at 0). */
const ramBase = (ctx: TickCtx, base: Base): void => {
  ctx.baseHp[base.name] = Math.max(0, ctx.baseHp[base.name] - BASE_RAM_DAMAGE);
  ctx.burstAt.push({
    x: Math.floor(base.x),
    y: Math.floor(base.y),
    kind: BURST_IMPACT,
    rgb: base.rgb,
  });
};

/** Shatter a rock: mark it dead, boom, and spill seed-rolled shrapnel. */
const shatterRock = (ctx: TickCtx, motion: MotionState, r: Rock): void => {
  const [frags, s2, nid] = spawnShrapnel(ctx.seed, motion.projId, r);
  ctx.seed = s2;
  motion.projId = nid;
  ctx.burstAt.push({
    x: Math.floor(r.x),
    y: Math.floor(r.y),
    kind: BURST_EXPLOSION,
  });
  for (const f of frags) motion.shards.push(f);
};

/** Resolve one overlapping ship/rock pair; returns whether to break the inner loop. */
const shipVsRock = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
  s: Ship,
  r: Rock,
): Step => {
  if (hazards.removedRocks.has(r.id)) return "next";
  const nx = wrapDelta(s.x, r.x, GRID_W);
  const ny = wrapDelta(s.y, r.y, GRID_H);
  const rad = r.size + shipRadius(s.level);
  const dist = Math.hypot(nx, ny);
  if (dist >= rad || dist < 1e-3) return "next";

  const [sv, rv] = elastic(
    [s.vx, s.vy],
    [r.vx, r.vy],
    [nx, ny],
    s.level,
    r.size * 3,
  );
  s.vx = sv[0];
  s.vy = sv[1];
  r.vx = rv[0];
  r.vy = rv[1];
  const [hx, hy] = normalize([s.vx, s.vy], [s.dx, s.dy]);
  s.dx = hx;
  s.dy = hy;
  const ux = nx / dist;
  const uy = ny / dist;
  s.x = wrap(s.x - ux * (rad - dist), GRID_W);
  s.y = wrap(s.y - uy * (rad - dist), GRID_H);

  if (s.hitCooldown > 0) return "next";
  hit(ctx, s, 1);
  s.hitCooldown = HIT_COOLDOWN;
  r.hp -= 1;
  if (r.hp <= 0) {
    hazards.removedRocks.add(r.id);
    shatterRock(ctx, motion, r);
  }
  if (s.hp <= 0) {
    killShip(ctx, s);
    return "break";
  }
  return "next";
};

const collideShipsRocks = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
): void => {
  for (const s of ctx.moved) {
    if (ctx.removed.has(s.id)) continue;
    for (const r of motion.rocks) {
      if (shipVsRock(ctx, motion, hazards, s, r) === "break") break;
    }
  }
};

/** Bounce a body off a base with a reflection; caller supplies the damage step. */
const reflectOffBase = (
  pos: { x: number; y: number; vx: number; vy: number },
  base: Base,
  bodyRad: number,
): { dist: number; vdot: number } => {
  const nx = wrapDelta(pos.x, base.x, GRID_W);
  const ny = wrapDelta(pos.y, base.y, GRID_H);
  const rad = BASE_RADIUS + bodyRad;
  const dist = Math.hypot(nx, ny);
  if (dist >= rad || dist < 1e-3) return { dist, vdot: -1 };
  const ux = nx / dist;
  const uy = ny / dist;
  pos.x = wrap(pos.x - ux * (rad - dist), GRID_W);
  pos.y = wrap(pos.y - uy * (rad - dist), GRID_H);
  const vdot = pos.vx * ux + pos.vy * uy;
  if (vdot > 0) {
    pos.vx -= 2 * vdot * ux;
    pos.vy -= 2 * vdot * uy;
  }
  return { dist, vdot };
};

const shipVsBase = (ctx: TickCtx, s: Ship, base: Base): Step => {
  if (base.name === s.colorName || ctx.baseHp[base.name] <= 0) return "next";
  const { dist, vdot } = reflectOffBase(s, base, shipRadius(s.level));
  const rad = BASE_RADIUS + shipRadius(s.level);
  if (dist >= rad || dist < 1e-3) return "next";
  if (vdot > 0) {
    const [hx, hy] = normalize([s.vx, s.vy], [s.dx, s.dy]);
    s.dx = hx;
    s.dy = hy;
  }
  if (s.hitCooldown <= 0) {
    hit(ctx, s, 1);
    s.hitCooldown = HIT_COOLDOWN;
    ramBase(ctx, base);
    if (s.hp <= 0) killShip(ctx, s);
  }
  return "break";
};

const collideShipsBases = (ctx: TickCtx): void => {
  for (const s of ctx.moved) {
    if (ctx.removed.has(s.id)) continue;
    for (const base of TEAM_BASES) {
      if (shipVsBase(ctx, s, base) === "break") break;
    }
  }
};

const rockVsBase = (ctx: TickCtx, r: Rock, base: Base): Step => {
  if (ctx.baseHp[base.name] <= 0) return "next";
  const rad = BASE_RADIUS + r.size;
  const { dist, vdot } = reflectOffBase(r, base, r.size);
  if (dist >= rad || dist < 1e-3) return "next";
  if (vdot > 0) ramBase(ctx, base);
  return "break";
};

const collideRocksBases = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
): void => {
  for (const r of motion.rocks) {
    if (hazards.removedRocks.has(r.id)) continue;
    for (const base of TEAM_BASES) {
      if (rockVsBase(ctx, r, base) === "break") break;
    }
  }
};

const shardVsShip = (
  ctx: TickCtx,
  hazards: HazardState,
  f: Mutable<Projectile>,
  s: Ship,
): Step => {
  const rad = SHRAPNEL_RADIUS + shipRadius(s.level);
  const dx = toroidalDist(s.x, f.x, GRID_W);
  const dy = toroidalDist(s.y, f.y, GRID_H);
  if (dx * dx + dy * dy >= rad * rad) return "next";
  hazards.removedShards.add(f.id);
  if (s.hitCooldown <= 0) {
    hit(ctx, s, 1);
    s.hitCooldown = HIT_COOLDOWN;
    if (s.hp <= 0) killShip(ctx, s);
  }
  return "break";
};

const collideShardsShips = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
): void => {
  for (const f of motion.shards) {
    for (const s of ctx.moved) {
      if (ctx.removed.has(s.id)) continue;
      if (shardVsShip(ctx, hazards, f, s) === "break") break;
    }
  }
};

/** Ship ↔ asteroid, ship ↔ enemy base, asteroid ↔ base, shrapnel ↔ ship. */
export const resolveHazardCollisions = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
) => {
  collideShipsRocks(ctx, motion, hazards);
  collideShipsBases(ctx);
  collideRocksBases(ctx, motion, hazards);
  collideShardsShips(ctx, motion, hazards);
};

export type MutableAsteroid = Mutable<Asteroid>;
export type MutableProjectile = Mutable<Projectile>;
