import {
  BASE_RADIUS,
  BULLET_RADIUS,
  MISSILE_RADIUS,
  SCORE_KILL,
  shipRadius,
  spawnShrapnel,
  toroidalDist,
} from "../factory";
import {
  type Asteroid,
  type Base,
  BURST_DETONATION,
  BURST_EXPLOSION,
  BURST_IMPACT,
  GRID_H,
  GRID_W,
  type LightCycle,
  type Mutable,
  type Rgb,
  TEAM_BASES,
} from "../types";
import { creditBaseHit, hit, killShip, type TickCtx } from "./context";
import type { HazardState } from "./hazard-collisions";
import type { MotionState } from "./motion";

export interface ProjectileState {
  removedBullets: Set<number>;
  removedMissiles: Set<number>;
}

export const createProjectileState = (): ProjectileState => ({
  removedBullets: new Set<number>(),
  removedMissiles: new Set<number>(),
});

type Ship = Mutable<LightCycle>;
type Step = "break" | "next"; // inner-loop control returned by a pair handler
// Common shape of a bullet or missile for the base-impact path.
type Munition = {
  x: number;
  y: number;
  id: number;
  damage: number;
  owner: number;
};

/** Shatter a rock: boom, spill seed-rolled shrapnel (mutates ctx.seed/projId). */
const shatterRock = (
  ctx: TickCtx,
  motion: MotionState,
  r: Mutable<Asteroid>,
): void => {
  ctx.burstAt.push({
    x: Math.floor(r.x),
    y: Math.floor(r.y),
    kind: BURST_EXPLOSION,
  });
  const [frags, s2, nid] = spawnShrapnel(ctx.seed, motion.projId, r);
  ctx.seed = s2;
  motion.projId = nid;
  for (const f of frags) motion.shards.push(f);
};

const bulletVsShip = (
  ctx: TickCtx,
  s: Ship,
  bt: MotionState["bullets"][number],
  projectiles: ProjectileState,
): Step => {
  if (ctx.removed.has(s.id) || s.colorName === bt.team) return "next";
  const rad = BULLET_RADIUS + shipRadius(s.level);
  const dx = toroidalDist(s.x, bt.x, GRID_W);
  const dy = toroidalDist(s.y, bt.y, GRID_H);
  if (dx * dx + dy * dy >= rad * rad) return "next";
  projectiles.removedBullets.add(bt.id);
  ctx.burstAt.push({
    x: Math.floor(bt.x),
    y: Math.floor(bt.y),
    kind: BURST_IMPACT,
    rgb: bt.rgb,
  });
  hit(ctx, s, bt.damage);
  if (s.hp <= 0) {
    ctx.score[bt.team] += SCORE_KILL;
    killShip(ctx, s);
  }
  return "break";
};

const bulletVsRock = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
  r: Mutable<Asteroid>,
  bt: MotionState["bullets"][number],
  projectiles: ProjectileState,
): Step => {
  if (hazards.removedRocks.has(r.id)) return "next";
  const rad = BULLET_RADIUS + r.size;
  const dx = toroidalDist(r.x, bt.x, GRID_W);
  const dy = toroidalDist(r.y, bt.y, GRID_H);
  if (dx * dx + dy * dy >= rad * rad) return "next";
  projectiles.removedBullets.add(bt.id);
  ctx.burstAt.push({
    x: Math.floor(bt.x),
    y: Math.floor(bt.y),
    kind: BURST_IMPACT,
    rgb: bt.rgb,
  });
  r.hp -= bt.damage;
  if (r.hp <= 0) {
    hazards.removedRocks.add(r.id);
    shatterRock(ctx, motion, r);
  }
  return "break";
};

/** Bullet/missile impact on an enemy base: chip HP, credit the raid, flash. */
const munitionVsBase = (
  ctx: TickCtx,
  base: Base,
  m: Munition,
  team: string,
  removedSet: Set<number>,
  kind: number,
  rgb?: Rgb,
): Step => {
  if (base.name === team || ctx.baseHp[base.name] <= 0) return "next";
  const dx = toroidalDist(base.x, m.x, GRID_W);
  const dy = toroidalDist(base.y, m.y, GRID_H);
  if (dx * dx + dy * dy >= BASE_RADIUS * BASE_RADIUS) return "next";
  removedSet.add(m.id);
  ctx.baseHp[base.name] = Math.max(0, ctx.baseHp[base.name] - m.damage);
  creditBaseHit(ctx, m.owner, base.name);
  ctx.burstAt.push({ x: Math.floor(m.x), y: Math.floor(m.y), kind, rgb });
  return "break";
};

const missileVsShip = (
  ctx: TickCtx,
  s: Ship,
  mi: MotionState["missiles"][number],
  projectiles: ProjectileState,
): Step => {
  if (ctx.removed.has(s.id) || s.colorName === mi.team) return "next";
  const rad = MISSILE_RADIUS + shipRadius(s.level);
  const dx = toroidalDist(s.x, mi.x, GRID_W);
  const dy = toroidalDist(s.y, mi.y, GRID_H);
  if (dx * dx + dy * dy >= rad * rad) return "next";
  projectiles.removedMissiles.add(mi.id);
  ctx.burstAt.push({
    x: Math.floor(mi.x),
    y: Math.floor(mi.y),
    kind: BURST_DETONATION,
  });
  hit(ctx, s, mi.damage);
  if (s.hp <= 0) {
    ctx.score[mi.team] += SCORE_KILL;
    killShip(ctx, s);
  }
  return "break";
};

const bulletsVsShips = (
  ctx: TickCtx,
  motion: MotionState,
  projectiles: ProjectileState,
): void => {
  for (const bt of motion.bullets) {
    if (projectiles.removedBullets.has(bt.id)) continue;
    for (const s of ctx.moved) {
      if (bulletVsShip(ctx, s, bt, projectiles) === "break") break;
    }
  }
};

const bulletsVsRocks = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
  projectiles: ProjectileState,
): void => {
  for (const bt of motion.bullets) {
    if (projectiles.removedBullets.has(bt.id)) continue;
    for (const r of motion.rocks) {
      if (bulletVsRock(ctx, motion, hazards, r, bt, projectiles) === "break")
        break;
    }
  }
};

const bulletsVsBases = (
  ctx: TickCtx,
  motion: MotionState,
  projectiles: ProjectileState,
): void => {
  for (const bt of motion.bullets) {
    if (projectiles.removedBullets.has(bt.id)) continue;
    for (const base of TEAM_BASES) {
      const step = munitionVsBase(
        ctx,
        base,
        bt,
        bt.team,
        projectiles.removedBullets,
        BURST_IMPACT,
        bt.rgb,
      );
      if (step === "break") break;
    }
  }
};

const missilesVsShips = (
  ctx: TickCtx,
  motion: MotionState,
  projectiles: ProjectileState,
): void => {
  for (const mi of motion.missiles) {
    if (projectiles.removedMissiles.has(mi.id)) continue;
    for (const s of ctx.moved) {
      if (missileVsShip(ctx, s, mi, projectiles) === "break") break;
    }
  }
};

const missilesVsBases = (
  ctx: TickCtx,
  motion: MotionState,
  projectiles: ProjectileState,
): void => {
  for (const mi of motion.missiles) {
    if (projectiles.removedMissiles.has(mi.id)) continue;
    for (const base of TEAM_BASES) {
      const step = munitionVsBase(
        ctx,
        base,
        mi,
        mi.team,
        projectiles.removedMissiles,
        BURST_DETONATION,
      );
      if (step === "break") break;
    }
  }
};

/** Bullet and missile hits against ships, rocks, and enemy bases. */
export const resolveProjectiles = (
  ctx: TickCtx,
  motion: MotionState,
  hazards: HazardState,
  projectiles: ProjectileState,
) => {
  bulletsVsShips(ctx, motion, projectiles);
  bulletsVsRocks(ctx, motion, hazards, projectiles);
  bulletsVsBases(ctx, motion, projectiles);
  missilesVsShips(ctx, motion, projectiles);
  missilesVsBases(ctx, motion, projectiles);
};
