import { wrapDelta } from "~/engine/physics";
import type { Seed } from "~/engine/rng";
import { nextFloat } from "~/engine/rng";
import {
  AIM_ASSIST_BIAS,
  AIM_ASSIST_CONE_COS,
  AIM_ASSIST_RANGE,
  ARC_CHAIN_FALLOFF,
  ARC_CHAIN_RANGE,
  ARC_DAMAGE,
  ARC_FIRE_CHANCE,
  ARC_MAX_LINKS,
  ARC_MIN_LEVEL,
  ARC_RANGE,
  acquireTarget,
  carriesArc,
  carriesMissiles,
  EMP_MISSILE_LOCK,
  fireCooldownFor,
  fireRangeFor,
  MISSILE_FIRE_CHANCE,
  MISSILE_MIN_LEVEL,
  MISSILE_RANGE,
  MUSTER_DRONE_RANGE_MULT,
  OVERCHARGE_MULT,
  PILOT_FIRE_MULT,
  SCORE_KILL,
  shipRadius,
  spawnBullet,
  spawnEmpMissile,
  spawnMissile,
  type WeaponProfile,
  weaponFor,
  wrap,
} from "~/world/factory";
import { distSq } from "~/world/math";
import { hit, killShip, type TickCtx } from "~/world/tick/context";
import {
  ARENA,
  BURST_ARC,
  BURST_MUZZLE,
  type Bullet,
  type LightCycle,
  MAX_LEVEL,
  type Missile,
  type Mutable,
  TEAM_BASES,
} from "~/world/types";

type Aim = { x: number; y: number };

// Engagement reach for a ship: muster drone ships fire deliberately short (the
// bolt-life half of the nerf is applied in spawnBullet).
const shipFireRange = (s: Mutable<LightCycle>): number =>
  fireRangeFor(s.level, s.archetype) *
  (s.droneShip ? MUSTER_DRONE_RANGE_MULT : 1);

/** Nearest alive enemy base within fire range (the raid target when no ship is closer). */
const nearestEnemyBaseAim = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
): Aim | null => {
  const range = shipFireRange(s);
  let best = range * range;
  let tx: number | null = null;
  let ty: number | null = null;
  for (const base of TEAM_BASES) {
    if (base.name === s.colorName || ctx.baseHp[base.name] <= 0) continue;
    const d2 = distSq(s.x, s.y, base.x, base.y);
    if (d2 >= best) continue;
    best = d2;
    tx = base.x;
    ty = base.y;
  }
  return tx !== null && ty !== null ? { x: tx, y: ty } : null;
};

/** Tinted muzzle flash at the ship's nose, oriented along the bolt heading. */
const muzzleFlash = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  angle: number,
): void => {
  const muzzle = shipRadius(s.level) + 1;
  ctx.burstAt.push({
    x: Math.floor(wrap(s.x + Math.sin(angle) * muzzle, ARENA.w)),
    y: Math.floor(wrap(s.y + Math.cos(angle) * muzzle, ARENA.h)),
    kind: BURST_MUZZLE,
    rgb: s.color,
    rot: angle,
  });
};

/**
 * Fire one salvo at `aim`: a burst fires a single bolt (its rhythm comes from
 * the cadence), while parallel/single patterns fire `barrels` bolts abreast,
 * centered on the nose and fanned out by the profile's spread. Returns the
 * advanced bullet-id counter.
 */
const spawnSalvo = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  aim: Aim,
  bullets: Mutable<Bullet>[],
  bulletId: number,
  wp: WeaponProfile,
): number => {
  const shots = wp.pattern === "burst" ? 1 : wp.barrels;
  const mid = (shots - 1) / 2;
  let id = bulletId;
  for (let i = 0; i < shots; i++) {
    const bolt = spawnBullet(id, s, aim.x, aim.y, (i - mid) * wp.spread);
    bullets.push(bolt);
    muzzleFlash(ctx, s, bolt.angle);
    id += 1;
  }
  return id;
};

/**
 * Cooldown after a shot, advancing burst state as a side effect: a burst uses
 * the short intra-salvo gap until its last shot, then the full reload; every
 * other pattern always reloads fully. Overcharge scales both.
 */
const applyFireCadence = (
  s: Mutable<LightCycle>,
  wp: WeaponProfile,
): number => {
  const oc = s.overchargeTime > 0 ? OVERCHARGE_MULT : 1;
  const full = fireCooldownFor(s.archetype, s.level) * oc;
  if (wp.pattern !== "burst") return full;
  s.burstCount += 1;
  if (s.burstCount >= wp.burstShots) {
    s.burstCount = 0;
    return full;
  }
  return wp.burstGap * oc;
};

/** Fire at the nearest enemy ship in range, else strafe the nearest alive enemy base. */
// Where a piloted ship shoots: along the live steering input, so holding two
// direction keys fires a clean diagonal instead of chasing the momentum-lagged
// heading. Coasting (no keys) falls back to the heading, so it still fires
// forward when you let go.
const manualAim = (
  s: LightCycle,
  keys: { left: boolean; right: boolean; up: boolean; down: boolean },
): Aim => {
  const ix = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const iy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  return ix || iy
    ? { x: s.x + ix * 100, y: s.y + iy * 100 }
    : { x: s.x + s.dx * 100, y: s.y + s.dy * 100 };
};

// Distance to `e` if it lies within the aim-assist cone of unit direction
// (dx, dy) and in range, else null. Toroidal.
const coneDist = (
  s: Mutable<LightCycle>,
  e: LightCycle,
  dx: number,
  dy: number,
): number | null => {
  const ex = wrapDelta(s.x, e.x, ARENA.w);
  const ey = wrapDelta(s.y, e.y, ARENA.h);
  const dist = Math.hypot(ex, ey);
  if (dist < 1 || dist > AIM_ASSIST_RANGE) return null;
  return (ex * dx + ey * dy) / dist >= AIM_ASSIST_CONE_COS ? dist : null;
};

// Nearest live enemy within the aim-assist cone of a unit direction (dx, dy).
const assistCandidate = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  dx: number,
  dy: number,
): Mutable<LightCycle> | null => {
  let best: Mutable<LightCycle> | null = null;
  let bestDist = Infinity;
  for (const e of ctx.moved) {
    if (e.colorName === s.colorName || ctx.removed.has(e.id)) continue;
    const dist = coneDist(s, e, dx, dy);
    if (dist !== null && dist < bestDist) {
      bestDist = dist;
      best = e;
    }
  }
  return best;
};

// Subtle arcade aim assist: if an enemy sits within a narrow cone of the shot,
// bias the aim toward it (partial, not a lock). Toroidal-aware.
const assistAim = (ctx: TickCtx, s: Mutable<LightCycle>, aim: Aim): Aim => {
  const ax = wrapDelta(s.x, aim.x, ARENA.w);
  const ay = wrapDelta(s.y, aim.y, ARENA.h);
  const ad = Math.hypot(ax, ay) || 1;
  const dx = ax / ad;
  const dy = ay / ad;
  const best = assistCandidate(ctx, s, dx, dy);
  if (!best) return aim;
  const tx = wrapDelta(s.x, best.x, ARENA.w);
  const ty = wrapDelta(s.y, best.y, ARENA.h);
  const td = Math.hypot(tx, ty) || 1;
  const nx = dx + (tx / td - dx) * AIM_ASSIST_BIAS;
  const ny = dy + (ty / td - dy) * AIM_ASSIST_BIAS;
  return { x: s.x + nx * 100, y: s.y + ny * 100 };
};

// Final aim for a piloted shot: the steering-input direction, with Easy/Normal
// arcade forgiving small misses toward nearby enemies.
const pilotAim = (ctx: TickCtx, s: Mutable<LightCycle>): Aim => {
  // Hard lock: fire tracks the locked enemy's current position, fully decoupled
  // from steering, so the pilot can dodge while staying on target.
  const lockId = ctx.world.lockedTargetId;
  if (lockId != null) {
    const t = ctx.moved.find((m) => m.id === lockId && !ctx.removed.has(m.id));
    if (t && t.colorName !== s.colorName)
      return {
        x: s.x + wrapDelta(s.x, t.x, ARENA.w),
        y: s.y + wrapDelta(s.y, t.y, ARENA.h),
      };
  }
  // No lock (no enemy in range): free directional aim, with the cone nudge on
  // easy/normal.
  const aim = manualAim(s, ctx.world.controlKeys);
  const diff = ctx.world.config.arcade?.difficulty;
  return diff === "easy" || diff === "normal" ? assistAim(ctx, s, aim) : aim;
};

export const fireWeapon = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  bullets: Mutable<Bullet>[],
  bulletId: number,
): number => {
  if (s.id === ctx.world.controlledShipId) {
    // Pilot's primary blaster is free (fuel gates only abilities) and snappier
    // than the base cadence, so waves clear faster / you're exposed less.
    if (ctx.world.controlKeys.space && s.fireCooldown <= 0) {
      const aim = pilotAim(ctx, s);
      const wp = weaponFor(s.archetype, s.level);
      const nextId = spawnSalvo(ctx, s, aim, bullets, bulletId, wp);
      s.fireCooldown = applyFireCadence(s, wp) * PILOT_FIRE_MULT;
      return nextId;
    }
    return bulletId;
  }
  const { moved, removed } = ctx;
  if (!(s.fuel > 0 && s.fireCooldown <= 0)) return bulletId;

  const range = shipFireRange(s);
  const target = acquireTarget(s, moved, range, removed);
  // No enemy ship in range → strafe the nearest alive enemy base (the raid).
  const aim: Aim | null =
    target && target.dist <= range
      ? { x: target.ship.x, y: target.ship.y }
      : nearestEnemyBaseAim(ctx, s);
  if (!aim) return bulletId;

  const wp = weaponFor(s.archetype, s.level);
  const nextId = spawnSalvo(ctx, s, aim, bullets, bulletId, wp);
  s.fireCooldown = applyFireCadence(s, wp);
  return nextId;
};

/** Missile-carriers roll to launch at their nearest enemy, in missile range. */
export const fireMissile = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  missiles: Mutable<Missile>[],
  missileId: number,
  seed: Seed,
): [number, Seed] => {
  if (s.id === ctx.world.controlledShipId) return [missileId, seed];
  const { moved, removed, steps } = ctx;
  if (
    !(
      s.fuel > 0 &&
      carriesMissiles(s.archetype) &&
      s.level >= MISSILE_MIN_LEVEL
    )
  ) {
    return [missileId, seed];
  }
  const [roll, nextSeed] = nextFloat(seed);
  if (roll >= MISSILE_FIRE_CHANCE * steps) return [missileId, nextSeed];

  const tgt = acquireTarget(s, moved, MISSILE_RANGE, removed);
  if (!tgt || tgt.dist > MISSILE_RANGE) return [missileId, nextSeed];

  // L5 capstone: an ace interceptor's missiles detonate as area blasts.
  const launch = s.level >= MAX_LEVEL ? spawnEmpMissile : spawnMissile;
  missiles.push(launch(missileId, s, tgt.ship));
  return [missileId + 1, nextSeed];
};

// Apply one chain-lightning node strike: pierce damage, credit + clean up a kill.
const arcStrike = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  victim: Mutable<LightCycle>,
  dmg: number,
) => {
  hit(ctx, victim, dmg, "pierce", s.id);
  if (victim.hp <= 0) {
    ctx.score[s.colorName] += SCORE_KILL;
    killShip(ctx, victim);
  }
};

// Paint one lightning link (from → to) as a team-tinted BURST_ARC.
const paintArc = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  fx: number,
  fy: number,
  to: Mutable<LightCycle>,
) => {
  ctx.burstAt.push({
    x: fx,
    y: fy,
    x2: to.x,
    y2: to.y,
    kind: BURST_ARC,
    rgb: s.color,
  });
};

// Nearest live enemy of `s` to point (px,py) within `range`, skipping ids in
// `skip` — used to fork the arc to a second target near the first.
const nearestEnemyTo = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  px: number,
  py: number,
  range: number,
  skip: Set<number>,
): Mutable<LightCycle> | null => {
  let best: Mutable<LightCycle> | null = null;
  let bestD2 = range * range;
  for (const e of ctx.moved) {
    if (ctx.removed.has(e.id) || e.colorName === s.colorName || skip.has(e.id))
      continue;
    const dx = e.x - px;
    const dy = e.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = e;
    }
  }
  return best;
};

// Walk the lightning from node to node: each link jumps to the nearest unstruck
// enemy within ARC_CHAIN_RANGE of the last node, up to ARC_MAX_LINKS nodes, and
// deals pierce damage that decays ARC_CHAIN_FALLOFF× per hop. Deterministic —
// no RNG inside (nearest-by-distance over the fixed ship order).
const chainArc = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  first: Mutable<LightCycle>,
) => {
  const struck = new Set<number>([s.id]);
  let fx = s.x;
  let fy = s.y;
  let node: Mutable<LightCycle> | null = first;
  let dmg = ARC_DAMAGE;
  for (let link = 0; node && link < ARC_MAX_LINKS; link++) {
    paintArc(ctx, s, fx, fy, node);
    arcStrike(ctx, s, node, dmg);
    struck.add(node.id);
    fx = node.x;
    fy = node.y;
    dmg *= ARC_CHAIN_FALLOFF;
    node = nearestEnemyTo(ctx, s, fx, fy, ARC_CHAIN_RANGE, struck);
  }
};

/**
 * Chain-lightning capstone (arc classes at ARC_MIN_LEVEL): a seeded per-gen proc
 * hitscans the nearest enemy in ARC_RANGE, then arcs from node to node (see
 * chainArc) — a tesla bolt that walks a cluster, fading with each hop.
 */
export const fireArc = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  seed: Seed,
): Seed => {
  if (s.id === ctx.world.controlledShipId) return seed;
  if (!(s.fuel > 0 && carriesArc(s.archetype) && s.level >= ARC_MIN_LEVEL)) {
    return seed;
  }
  const [roll, next] = nextFloat(seed);
  if (roll >= ARC_FIRE_CHANCE * ctx.steps) return next;

  const primary = acquireTarget(s, ctx.moved, ARC_RANGE, ctx.removed);
  if (!primary || primary.dist > ARC_RANGE) return next;
  chainArc(ctx, s, primary.ship);
  return next;
};

/**
 * EMP pickup: launch a homing missile that seeks the nearest enemy and, on
 * contact, detonates as an area blast (see missileVsShip). Returns the advanced
 * missile-id counter. No enemy in lock range → no launch.
 */
export const fireEmpMissile = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  missiles: Mutable<Missile>[],
  missileId: number,
): number => {
  const tgt = acquireTarget(s, ctx.moved, EMP_MISSILE_LOCK, ctx.removed);
  if (!tgt) return missileId;
  missiles.push(spawnEmpMissile(missileId, s, tgt.ship));
  return missileId + 1;
};
