import {
  elastic,
  normalize,
  reflectOffDisc,
  wrapDelta,
} from "~/engine/physics";
import {
  BASE_RADIUS,
  BASE_RAM_DAMAGE,
  baseRamDamage,
  CENTER_PAD_RADIUS,
  HIT_COOLDOWN,
  SHRAPNEL_RADIUS,
  shipRadius,
  spawnShrapnel,
  wrap,
} from "../factory";
import { within } from "../math";
import {
  ARENA,
  type Asteroid,
  type Base,
  BURST_EXPLOSION,
  BURST_SHIELD,
  CENTER_PAD,
  type LightCycle,
  type Mutable,
  type Projectile,
  TEAM_BASES,
} from "../types";
import {
  creditBaseHit,
  hit,
  killShip,
  maybeRamShock,
  type TickCtx,
} from "./context";
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

/** Damage a team base by a ram and flag the shield-deflection FX (clamped at 0). */
const ramBase = (
  ctx: TickCtx,
  base: Base,
  amount: number = BASE_RAM_DAMAGE,
): void => {
  ctx.baseHp[base.name] = Math.max(0, ctx.baseHp[base.name] - amount);
  ctx.burstAt.push({
    x: Math.floor(base.x),
    y: Math.floor(base.y),
    kind: BURST_SHIELD,
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
  const nx = wrapDelta(s.x, r.x, ARENA.w);
  const ny = wrapDelta(s.y, r.y, ARENA.h);
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
  s.x = wrap(s.x - ux * (rad - dist), ARENA.w);
  s.y = wrap(s.y - uy * (rad - dist), ARENA.h);

  if (s.hitCooldown > 0) return "next";
  hit(ctx, s, 1, "melee");
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

/** Bounce a body off a base; caller supplies the damage step. */
const reflectOffBase = (
  pos: { x: number; y: number; vx: number; vy: number },
  base: Base,
  bodyRad: number,
): { dist: number; vdot: number } =>
  reflectOffDisc(pos, base.x, base.y, BASE_RADIUS, bodyRad, ARENA.w, ARENA.h);

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
    // Rammers slam bases far harder (baseRamDamage) and shrug off the recoil —
    // the melee armor that softens the self-hit is applied centrally in `hit`.
    hit(ctx, s, 1, "melee");
    s.hitCooldown = HIT_COOLDOWN;
    ramBase(ctx, base, baseRamDamage(s));
    creditBaseHit(ctx, s.id, base.name); // rammer slams tally the raid too (+XP)
    maybeRamShock(ctx, s); // L5 rammer capstone: base slam → area shockwave
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

// Neutral gold, matching the center pad's dais tint, for its deflection ripple.
const CENTER_PAD_RGB = [1.0, 0.78, 0.35] as const;

/** Deflection ripple + point flash at the center-pad core, tinted its gold. */
const centerPadDeflect = (ctx: TickCtx): void => {
  ctx.burstAt.push({
    x: Math.floor(CENTER_PAD.x),
    y: Math.floor(CENTER_PAD.y),
    kind: BURST_SHIELD,
    rgb: CENTER_PAD_RGB,
  });
};

/** Ship ↔ center-pad core: bounce off the solid dais and chip the hull. */
const shipVsCenterPad = (ctx: TickCtx, s: Ship): void => {
  const { dist, vdot, rad } = reflectOffDisc(
    s,
    CENTER_PAD.x,
    CENTER_PAD.y,
    CENTER_PAD_RADIUS,
    shipRadius(s.level),
    ARENA.w,
    ARENA.h,
  );
  if (dist >= rad || dist < 1e-3) return;
  if (vdot > 0) {
    const [hx, hy] = normalize([s.vx, s.vy], [s.dx, s.dy]);
    s.dx = hx;
    s.dy = hy;
  }
  if (s.hitCooldown > 0) return;
  hit(ctx, s, 1, "melee");
  s.hitCooldown = HIT_COOLDOWN;
  centerPadDeflect(ctx);
  if (s.hp <= 0) killShip(ctx, s);
};

/** Rock ↔ center-pad core: bounce off; the neutral dais is indestructible. */
const rockVsCenterPad = (r: Rock): void => {
  reflectOffDisc(
    r,
    CENTER_PAD.x,
    CENTER_PAD.y,
    CENTER_PAD_RADIUS,
    r.size,
    ARENA.w,
    ARENA.h,
  );
};

const collideBodiesCenterPad = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
): void => {
  for (const s of ctx.moved) {
    if (!ctx.removed.has(s.id)) shipVsCenterPad(ctx, s);
  }
  for (const r of motion.rocks) {
    if (!hazards.removedRocks.has(r.id)) rockVsCenterPad(r);
  }
};

const shardVsShip = (
  ctx: TickCtx,
  hazards: HazardState,
  f: Mutable<Projectile>,
  s: Ship,
): Step => {
  const rad = SHRAPNEL_RADIUS + shipRadius(s.level);
  if (!within(s.x, s.y, f.x, f.y, rad)) return "next";
  hazards.removedShards.add(f.id);
  if (s.hitCooldown <= 0) {
    hit(ctx, s, 1, "melee");
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
  collideBodiesCenterPad(ctx, motion, hazards);
  collideShardsShips(ctx, motion, hazards);
};
