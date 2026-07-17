import { angleTo, normalize, wrapDelta } from "~/engine/physics";
import {
  BASE_RADIUS,
  BULLET_RADIUS,
  MISSILE_RADIUS,
  SCORE_KILL,
  shipRadius,
  spawnShrapnel,
  wrap,
  XP_LEVEL_CAP,
  XP_PER_ROCK,
} from "../factory";
import { within } from "../math";
import {
  ARENA,
  type Asteroid,
  type Base,
  BURST_DETONATION,
  BURST_EXPLOSION,
  BURST_IMPACT,
  type LightCycle,
  MAX_LEVEL,
  type Mutable,
  PORTALS,
  type Rgb,
  TEAM_BASES,
} from "../types";
import { gridCrossPairs, type PairList, runCrossPairs } from "./broadphase";
import {
  awardXp,
  creditBaseHit,
  damageBase,
  detonateBlast,
  hit,
  killShip,
  type TickCtx,
} from "./context";
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
  if (!within(s.x, s.y, bt.x, bt.y, rad)) return "next";
  projectiles.removedBullets.add(bt.id);
  ctx.burstAt.push({
    x: Math.floor(bt.x),
    y: Math.floor(bt.y),
    kind: BURST_IMPACT,
    rgb: bt.rgb,
    rot: bt.angle, // spray the flash along the bolt's travel direction
  });
  hit(ctx, s, bt.damage, "pierce", bt.owner);
  if (s.hp <= 0) {
    ctx.score[bt.team] += SCORE_KILL;
    killShip(ctx, s);
  }
  return "break";
};

// Deflect a bolt off a rock: reflect its velocity about the surface normal
// (rock centre → bolt, toroidal), park it just outside the hit radius so it
// can't immediately re-collide, and spend one bounce.
const ricochetOffRock = (
  bt: MotionState["bullets"][number],
  r: Asteroid,
  rad: number,
): void => {
  // Outward surface normal (rock centre → bolt) so the bolt is parked back on
  // the side it arrived from; wrapDelta(r, bt) = bt - r.
  const [nx, ny] = normalize(
    [wrapDelta(r.x, bt.x, ARENA.w), wrapDelta(r.y, bt.y, ARENA.h)],
    [-bt.vx, -bt.vy], // degenerate (dead-centre) hit: bounce straight back
  );
  const vdotn = bt.vx * nx + bt.vy * ny;
  bt.vx -= 2 * vdotn * nx;
  bt.vy -= 2 * vdotn * ny;
  bt.x = wrap(r.x + nx * (rad + 1), ARENA.w);
  bt.y = wrap(r.y + ny * (rad + 1), ARENA.h);
  bt.angle = angleTo([bt.vx, bt.vy]);
  bt.bounces -= 1;
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
  if (!within(r.x, r.y, bt.x, bt.y, rad)) return "next";
  ctx.burstAt.push({
    x: Math.floor(bt.x),
    y: Math.floor(bt.y),
    kind: BURST_IMPACT,
    rgb: bt.rgb,
    rot: bt.angle, // spray the flash along the bolt's travel direction
  });
  r.hp -= bt.damage;
  if (r.hp <= 0) {
    hazards.removedRocks.add(r.id);
    shatterRock(ctx, motion, r);
    awardXp(ctx, bt.owner, XP_PER_ROCK, XP_LEVEL_CAP); // capped catch-up trickle
    projectiles.removedBullets.add(bt.id); // a shattered rock absorbs the bolt
  } else if (bt.bounces > 0) {
    ricochetOffRock(bt, r, rad); // surviving rock deflects it
  } else {
    projectiles.removedBullets.add(bt.id); // no bounces left → spent
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
  rot?: number,
): Step => {
  if (base.name === team || ctx.baseHp[base.name] <= 0) return "next";
  if (!within(base.x, base.y, m.x, m.y, BASE_RADIUS)) return "next";
  removedSet.add(m.id);
  damageBase(ctx, base.name, m.damage);
  creditBaseHit(ctx, m.owner, base.name);
  ctx.burstAt.push({ x: Math.floor(m.x), y: Math.floor(m.y), kind, rgb, rot });
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
  if (!within(s.x, s.y, mi.x, mi.y, rad)) return "next";
  projectiles.removedMissiles.add(mi.id);
  // AoE missile: contact is just the fuse — damage everything in the blast.
  if (mi.blast) {
    detonateBlast(ctx, mi.x, mi.y, mi.team, mi.damage, mi.blast, mi.owner);
    return "break";
  }
  ctx.burstAt.push({
    x: Math.floor(mi.x),
    y: Math.floor(mi.y),
    kind: BURST_DETONATION,
  });
  hit(ctx, s, mi.damage, "pierce", mi.owner);
  if (s.hp <= 0) {
    ctx.score[mi.team] += SCORE_KILL;
    killShip(ctx, s);
  }
  return "break";
};

// Widest bullet↔ship hit radius (bullet + the largest ship). Ships don't move
// during projectile resolution, so the snapshot grid is exact — no drift margin.
const BULLET_SHIP_BAND = BULLET_RADIUS + shipRadius(MAX_LEVEL);

/** Candidate bullet×ship pairs for this tick (grouped by bullet, ship asc). */
export const bulletShipPairs = (
  ctx: TickCtx,
  motion: MotionState,
): PairList | null =>
  gridCrossPairs(motion.bullets, ctx.moved, ARENA, BULLET_SHIP_BAND);

// With `pairs`, replay only the candidate bullet×ship pairs (broad-phase); the
// per-bullet break and per-pair narrow-phase are identical to the nested loop, so
// the outcome matches bit-for-bit. Without `pairs`, the brute nested scan.
export const bulletsVsShips = (
  ctx: TickCtx,
  motion: MotionState,
  projectiles: ProjectileState,
  pairs?: PairList | null,
): void => {
  if (pairs) {
    runCrossPairs(pairs, (bi, ai) => {
      const bt = motion.bullets[bi];
      return projectiles.removedBullets.has(bt.id)
        ? true
        : bulletVsShip(ctx, ctx.moved[ai], bt, projectiles) === "break";
    });
    return;
  }
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
        bt.angle, // impact flash oriented along the bolt
      );
      if (step === "break") break;
    }
  }
};

// Widest missile↔ship hit radius; ships are static during projectile resolution.
const MISSILE_SHIP_BAND = MISSILE_RADIUS + shipRadius(MAX_LEVEL);

/** Candidate missile×ship pairs for this tick (grouped by missile, ship asc). */
export const missileShipPairs = (
  ctx: TickCtx,
  motion: MotionState,
): PairList | null =>
  gridCrossPairs(motion.missiles, ctx.moved, ARENA, MISSILE_SHIP_BAND);

// Broad-phase (with `pairs`) or brute nested scan — bit-identical (see bulletsVsShips).
export const missilesVsShips = (
  ctx: TickCtx,
  motion: MotionState,
  projectiles: ProjectileState,
  pairs?: PairList | null,
): void => {
  if (pairs) {
    runCrossPairs(pairs, (bi, ai) => {
      const mi = motion.missiles[bi];
      return projectiles.removedMissiles.has(mi.id)
        ? true
        : missileVsShip(ctx, ctx.moved[ai], mi, projectiles) === "break";
    });
    return;
  }
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

// A moving munition reappears at the linked gate when it enters a portal mouth,
// keeping its heading — the same shortcut ships and asteroids take. Exit is
// nudged just past the far gate along the velocity so it doesn't re-trigger.
const PORTAL_EXIT_MARGIN = 3;
const hopMunitionsThroughPortals = <
  T extends { x: number; y: number; vx: number; vy: number; id: number },
>(
  items: T[],
  removed: Set<number>,
): void => {
  for (const it of items) {
    if (removed.has(it.id)) continue;
    for (let g = 0; g < 2; g++) {
      const from = PORTALS[g];
      if (!within(it.x, it.y, from.x, from.y, from.r)) continue;
      const to = PORTALS[1 - g];
      const [ux, uy] = normalize([it.vx, it.vy]);
      it.x = wrap(to.x + ux * (to.r + PORTAL_EXIT_MARGIN), ARENA.w);
      it.y = wrap(to.y + uy * (to.r + PORTAL_EXIT_MARGIN), ARENA.h);
      break;
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
  // Portal hop first, so a bolt that jumps can still hit on the far side.
  hopMunitionsThroughPortals(motion.bullets, projectiles.removedBullets);
  hopMunitionsThroughPortals(motion.missiles, projectiles.removedMissiles);
  bulletsVsShips(ctx, motion, projectiles, bulletShipPairs(ctx, motion));
  bulletsVsRocks(ctx, motion, hazards, projectiles);
  bulletsVsBases(ctx, motion, projectiles);
  missilesVsShips(ctx, motion, projectiles, missileShipPairs(ctx, motion));
  missilesVsBases(ctx, motion, projectiles);
};
