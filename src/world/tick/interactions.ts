import { normalize, wrapDelta } from "~/engine/physics";
import type { Seed } from "~/engine/rng";
import { nextFloat, nextInt, nextRange } from "~/engine/rng";
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
  BASE_HEAL_RATE,
  BASE_HORIZON,
  BASE_MAX_HP,
  BASE_PULL,
  BASE_PUSH,
  BASE_RADIUS,
  BOOST_DURATION,
  baseHitsRequired,
  CARRIER_LEECH_LEVEL,
  CARRIER_LEECH_RADIUS,
  CARRIER_LEECH_RATE,
  CENTER_HORIZON,
  CENTER_PULL,
  CLOAK_DURATION,
  carriesArc,
  carriesMissiles,
  centerPadPhase,
  DRONE_COUNT,
  DRONE_DURATION,
  DRONE_FIRE_COOLDOWN,
  DRONE_FIRE_RANGE,
  DRONE_ORBIT_RADIUS,
  EMP_MISSILE_LOCK,
  FORCEFIELD_DAMAGE,
  FORCEFIELD_DURATION,
  FORCEFIELD_PUSH,
  FORCEFIELD_RADIUS,
  FUEL_CELL_KIND,
  FUEL_CELL_PUMP_RADIUS,
  FUEL_CELL_YIELD,
  FUEL_REFILL,
  FUEL_SHARE_RADIUS,
  FUEL_SHARE_RATE,
  FUEL_SHARE_RESERVE,
  fireCooldownFor,
  fireRangeFor,
  HIT_COOLDOWN,
  HOME_RADIUS,
  hasRaidedAllEnemyBases,
  isCarrier,
  isRecon,
  MINE_ARM,
  MINE_DAMAGE,
  MINE_DROP_CHANCE,
  MINE_LIFE,
  MINE_RADIUS,
  MISSILE_FIRE_CHANCE,
  MISSILE_MIN_LEVEL,
  MISSILE_RANGE,
  OVERCHARGE_DURATION,
  OVERCHARGE_MULT,
  PAD_HEAL,
  PICKUP_RADIUS,
  PILOT_FIRE_MULT,
  PORTAL_COOLDOWN,
  PORTAL_HORIZON,
  PORTAL_PULL,
  RECON_SHARE_RADIUS,
  rollShip,
  SCORE_KILL,
  SCORE_PICKUP,
  SHIELD_BASE_REGEN,
  shipRadius,
  spawnBullet,
  spawnDroneBolt,
  spawnEmpMissile,
  spawnMissile,
  type WeaponProfile,
  weaponFor,
  wrap,
} from "../factory";
import { distSq, within } from "../math";
import {
  ARENA,
  type Asteroid,
  BURST_ARC,
  BURST_DETONATION,
  BURST_MUZZLE,
  type Bullet,
  baseByName,
  CENTER_PAD,
  DRONE_KIND,
  type Drone,
  HEAL_PADS,
  type LightCycle,
  MAX_LEVEL,
  type Mine,
  type Missile,
  MUSTER_KIND,
  type Mutable,
  type Pickup,
  PORTALS,
  TEAM_BASES,
} from "../types";
import { gridNeighbors } from "./broadphase";
import { hit, killShip, promote, type TickCtx } from "./context";
import type { HazardState } from "./hazard-collisions";
import type { MotionState } from "./motion";

// Broad-phase band for the ship×ship aura passes = the widest aura reach. The
// auras run after every ship has moved and none of them changes a ship's
// position (forcefield only nudges velocity), so a grid built just before them is
// exact — each aura re-gates its own smaller radius. Fits the default 480×270
// field (≥3 cells/axis), so the shipped sim exercises the grid path too.
const AURA_BAND = Math.max(
  FORCEFIELD_RADIUS,
  FUEL_SHARE_RADIUS,
  CARRIER_LEECH_RADIUS,
  RECON_SHARE_RADIUS,
);
type NbrLists = readonly (readonly number[])[] | null;

// The "other ships" a ship at index i tests in an aura pass: its grid neighbours
// (mapped back to ships) or, with no grid built, the whole array — so each aura
// stays a single loop over one iterable.
const othersFor = (
  moved: readonly Mutable<LightCycle>[],
  nbr: NbrLists,
  i: number,
): readonly Mutable<LightCycle>[] =>
  nbr ? nbr[i].map((j) => moved[j]) : moved;

export interface InteractionState {
  takenPickups: Set<number>;
  removedMines: Set<number>;
}

export const createInteractionState = (): InteractionState => ({
  takenPickups: new Set<number>(),
  removedMines: new Set<number>(),
});

type Aim = { x: number; y: number };

/** Nearest alive enemy base within fire range (the raid target when no ship is closer). */
const nearestEnemyBaseAim = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
): Aim | null => {
  const range = fireRangeFor(s.level, s.archetype);
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

const fireWeapon = (
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

  const range = fireRangeFor(s.level, s.archetype);
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
const fireMissile = (
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
const fireArc = (ctx: TickCtx, s: Mutable<LightCycle>, seed: Seed): Seed => {
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
const fireEmpMissile = (
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

/**
 * Fuel cell: refill the harvesting carrier's tank, then pump every same-team
 * ally within reach by the same flat amount — a mobile depot injecting fuel
 * back into a starving squad so the match never stalls out juiceless.
 */
const harvestFuelCell = (ctx: TickCtx, s: Mutable<LightCycle>): void => {
  s.fuel = Math.min(s.maxFuel, s.fuel + FUEL_CELL_YIELD);
  for (const a of ctx.moved) {
    if (a.id === s.id || ctx.removed.has(a.id)) continue;
    if (a.colorName !== s.colorName || a.fuel >= a.maxFuel) continue;
    if (!within(s.x, s.y, a.x, a.y, FUEL_CELL_PUMP_RADIUS)) continue;
    a.fuel = Math.min(a.maxFuel, a.fuel + FUEL_CELL_YIELD);
  }
};

// Reinforcement power-up (arcade only): the collector's team gains 1–2 AI allies
// mustered at the pickup, queued into ctx.spawned so finalize commits them (still
// bounded by MAX_SHIPS like any spawn). Seeded off ctx.seed → deterministic.
const MUSTER_SPREAD = 10;
const musterAllies = (ctx: TickCtx, s: Mutable<LightCycle>): void => {
  if (!ctx.world.arcade) return;
  const [extra, s0] = nextInt(ctx.seed, 2); // 0..1 → 1..2 allies
  ctx.seed = s0;
  for (let k = 0; k <= extra; k++) {
    const [jx, s1] = nextRange(ctx.seed, -MUSTER_SPREAD, MUSTER_SPREAD);
    const [jy, s2] = nextRange(s1, -MUSTER_SPREAD, MUSTER_SPREAD);
    const [ally, s3] = rollShip(
      s2,
      ctx.nextId,
      wrap(s.x + jx, ARENA.w),
      wrap(s.y + jy, ARENA.h),
      s.level,
      s.colorName,
    );
    ctx.seed = s3;
    ctx.nextId += 1;
    ctx.spawned.push(ally);
  }
};

// Drone escort power-up: queue DRONE_COUNT drones evenly around the ship's orbit
// ring into ctx.spawnedDrones (finalize commits them). Staggered fire cooldowns
// so the ring doesn't volley in unison. No RNG → deterministic.
const musterDrones = (ctx: TickCtx, s: Mutable<LightCycle>): void => {
  const r = shipRadius(s.level) + DRONE_ORBIT_RADIUS;
  for (let k = 0; k < DRONE_COUNT; k++) {
    const phase = (k / DRONE_COUNT) * Math.PI * 2;
    ctx.spawnedDrones.push({
      x: wrap(s.x + Math.cos(phase) * r, ARENA.w),
      y: wrap(s.y + Math.sin(phase) * r, ARENA.h),
      ownerId: s.id,
      team: s.colorName,
      rgb: s.color,
      phase,
      slot: k,
      life: DRONE_DURATION,
      fireCooldown: Math.floor((k * DRONE_FIRE_COOLDOWN) / DRONE_COUNT),
    });
  }
};

/** Nearest live enemy of the drone's owner within fire range, else null. */
const nearestEnemyToDrone = (
  d: Mutable<Drone>,
  moved: readonly Mutable<LightCycle>[],
  removed: Set<number>,
): Mutable<LightCycle> | null => {
  let best: Mutable<LightCycle> | null = null;
  let bestD2 = DRONE_FIRE_RANGE * DRONE_FIRE_RANGE;
  for (const e of moved) {
    if (removed.has(e.id) || e.colorName === d.team) continue;
    const d2 = distSq(d.x, d.y, e.x, e.y);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = e;
    }
  }
  return best;
};

/** Apply one collected pickup's effect by kind (heal/shield/boost/.../EMP AoE). */
const applyPickup = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  kind: number,
  missiles: Mutable<Missile>[],
  missileId: number,
): number => {
  switch (kind) {
    case 0:
      s.hp = s.maxHp;
      break;
    case 1:
      s.shield = s.maxShield;
      break;
    case 2:
      s.boostTime = BOOST_DURATION;
      break;
    case 3:
      s.overchargeTime = OVERCHARGE_DURATION;
      break;
    case 5:
      promote(ctx, s);
      break;
    case 6:
      s.invulnTime = CLOAK_DURATION;
      break;
    case 7:
      s.forceFieldTime = FORCEFIELD_DURATION;
      break;
    case FUEL_CELL_KIND:
      harvestFuelCell(ctx, s);
      break;
    case MUSTER_KIND:
      musterAllies(ctx, s);
      break;
    case DRONE_KIND:
      musterDrones(ctx, s);
      break;
    default:
      return fireEmpMissile(ctx, s, missiles, missileId);
  }
  return missileId;
};

/**
 * Collect every unclaimed pickup within radius and apply its effect. Returns the
 * advanced missile-id counter (an EMP pickup launches a homing missile).
 */
const collectPickups = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  bubbles: Mutable<Pickup>[],
  takenPickups: Set<number>,
  missiles: Mutable<Missile>[],
  missileId: number,
): number => {
  let nextMissileId = missileId;
  for (const p of bubbles) {
    if (takenPickups.has(p.id)) continue;
    // Fuel cells are a carrier-only resource for the AI — non-carriers coast
    // through and leave them floating for a carrier to harvest. The human pilot
    // is exempt: whatever hull they picked, they must be able to refuel (else a
    // non-carrier pilot runs dry with no recourse).
    if (
      p.kind === FUEL_CELL_KIND &&
      !isCarrier(s.archetype) &&
      s.id !== ctx.world.controlledShipId
    ) {
      continue;
    }
    if (!within(s.x, s.y, p.x, p.y, PICKUP_RADIUS)) continue;
    takenPickups.add(p.id);
    ctx.score[s.colorName] += SCORE_PICKUP;
    nextMissileId = applyPickup(ctx, s, p.kind, missiles, nextMissileId);
  }
  return nextMissileId;
};

/** Heal from the first overlapping heal pad, if any. */
const healAtPad = (s: Mutable<LightCycle>, steps: number): void => {
  if (s.hp >= s.maxHp) return;
  for (const pad of HEAL_PADS) {
    if (within(s.x, s.y, pad.x, pad.y, pad.r)) {
      s.hp = Math.min(s.maxHp, s.hp + PAD_HEAL * steps);
      break;
    }
  }
};

/** Gravitational pull from any portal's event horizon. */
const pullTowardPortalHorizon = (
  s: Mutable<LightCycle>,
  steps: number,
): void => {
  for (const g of PORTALS) {
    const gx = wrapDelta(s.x, g.x, ARENA.w);
    const gy = wrapDelta(s.y, g.y, ARENA.h);
    const d2 = gx * gx + gy * gy;
    const horizon = g.r * PORTAL_HORIZON;
    if (d2 >= horizon * horizon || d2 < 1e-3) continue;
    const d = Math.sqrt(d2);
    const pull = PORTAL_PULL * (1 - d / horizon) * steps;
    s.vx += (gx / d) * pull;
    s.vy += (gy / d) * pull;
  }
};

/**
 * Base gravity well: an intact base draws its own ships inward and repels
 * intruders, the physical counterpart of the base's inward force-field visual.
 * Reach and strength both scale with the base's remaining integrity, so a
 * crumbling base loses its grip.
 */
const applyBaseGravity = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  steps: number,
): void => {
  for (const b of TEAM_BASES) {
    const frac = ctx.baseHp[b.name] / BASE_MAX_HP;
    if (frac <= 0) continue; // dead base has no field
    const gx = wrapDelta(s.x, b.x, ARENA.w);
    const gy = wrapDelta(s.y, b.y, ARENA.h);
    const d2 = gx * gx + gy * gy;
    const horizon = BASE_RADIUS * BASE_HORIZON;
    if (d2 >= horizon * horizon || d2 < 1e-3) continue;
    const d = Math.sqrt(d2);
    const falloff = (1 - d / horizon) * frac * steps;
    // gx/gy point toward the base: allies pull in (+), intruders shove out (−).
    const accel =
      s.colorName === b.name ? BASE_PULL * falloff : -BASE_PUSH * falloff;
    s.vx += (gx / d) * accel;
    s.vy += (gy / d) * accel;
  }
};

/**
 * Star gravity: the centre pad is a little gravity well that draws every ship
 * gently inward (neutral — no team owns it). The pull eases to zero out at the
 * orbit-ring radius and firms up toward the core, where the pad's hard centre
 * deflects hulls — so ships swing past in arcs rather than collapsing in.
 */
const applyStarGravity = (s: Mutable<LightCycle>, steps: number): void => {
  const gx = wrapDelta(s.x, CENTER_PAD.x, ARENA.w);
  const gy = wrapDelta(s.y, CENTER_PAD.y, ARENA.h);
  const d2 = gx * gx + gy * gy;
  const horizon = CENTER_PAD.r * CENTER_HORIZON;
  if (d2 >= horizon * horizon || d2 < 1e-3) return;
  const d = Math.sqrt(d2);
  const pull = CENTER_PULL * (1 - d / horizon) * steps;
  s.vx += (gx / d) * pull;
  s.vy += (gy / d) * pull;
};

/** Step through a portal mouth to the other one, if standing in it and off cooldown. */
const teleportThroughPortal = (s: Mutable<LightCycle>): void => {
  if (s.portalCooldown > 0) return;
  for (let g = 0; g < 2; g++) {
    const from = PORTALS[g];
    if (within(s.x, s.y, from.x, from.y, from.r)) {
      const to = PORTALS[1 - g];
      s.x = wrap(to.x + s.dx * (to.r + 2), ARENA.w);
      s.y = wrap(to.y + s.dy * (to.r + 2), ARENA.h);
      s.portalCooldown = PORTAL_COOLDOWN;
      break;
    }
  }
};

/** Roll to drop an armed mine behind the ship. */
const dropMine = (
  _ctx: TickCtx,
  s: Mutable<LightCycle>,
  mines: Mutable<Mine>[],
  mineId: number,
  seed: Seed,
  steps: number,
): [number, Seed] => {
  if (s.id === _ctx.world.controlledShipId) return [mineId, seed];
  if (!(s.fuel > 0 && s.mines > 0)) return [mineId, seed];
  const [roll, nextSeed] = nextFloat(seed);
  if (roll >= MINE_DROP_CHANCE * steps) return [mineId, nextSeed];

  s.mines -= 1;
  const back = shipRadius(s.level) + 3;
  mines.push({
    id: mineId,
    x: wrap(s.x - s.dx * back, ARENA.w),
    y: wrap(s.y - s.dy * back, ARENA.h),
    team: s.colorName,
    rgb: s.color,
    arm: MINE_ARM,
    life: MINE_LIFE,
    spin: 0,
    spinRate: 0.06,
  });
  return [mineId + 1, nextSeed];
};

/** Refill shield/mines/fuel and top up the home base while docked. */
const dockAtHomeBase = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  steps: number,
): void => {
  const home = baseByName.get(s.colorName);
  if (!home) return;
  if (!within(s.x, s.y, home.x, home.y, HOME_RADIUS)) return;

  s.shield = Math.min(
    s.maxShield,
    s.shield + s.maxShield * SHIELD_BASE_REGEN * steps,
  );
  s.mines = s.maxMines;
  s.fuel = Math.min(s.maxFuel, s.fuel + FUEL_REFILL * steps);
  // Docking repairs a damaged home base, but never revives a razed one (hp 0):
  // a destroyed base stays destroyed and its team is eliminated.
  if (!ctx.suddenDeath && ctx.baseHp[s.colorName] > 0) {
    ctx.baseHp[s.colorName] = Math.min(
      BASE_MAX_HP,
      ctx.baseHp[s.colorName] + BASE_HEAL_RATE * steps,
    );
  }
};

/**
 * The center pad: heals + regenerates shield for any ship over it, and — if the
 * ship has already raided every alive enemy base — cashes in the level-up. The
 * raid tally then resets. This is the "fly over center to finish" half of the
 * level goal (the raid half is tallied in creditBaseHit).
 */
const finishAtCenterPad = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  steps: number,
): void => {
  if (!within(s.x, s.y, CENTER_PAD.x, CENTER_PAD.y, CENTER_PAD.r)) return;
  // Neutral central depot, but it only dispenses one resource at a time — the
  // active phase cycles hp → fuel → shield so holding it is worth different
  // things at different moments (see centerPadPhase).
  const phase = centerPadPhase(ctx.world.age);
  if (phase === "hp") {
    s.hp = Math.min(s.maxHp, s.hp + PAD_HEAL * steps);
  } else if (phase === "fuel") {
    s.fuel = Math.min(s.maxFuel, s.fuel + FUEL_REFILL * steps);
  } else {
    s.shield = Math.min(
      s.maxShield,
      s.shield + s.maxShield * SHIELD_BASE_REGEN * steps,
    );
  }
  if (s.level >= MAX_LEVEL || !hasRaidedAllEnemyBases(s, ctx.baseHp)) return;
  promote(ctx, s);
  s.baseHits = {};
};

/** Push + zap one enemy caught in `s`'s force-field aura, if it's in range. */
const forceFieldStrike = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  e: Mutable<LightCycle>,
  steps: number,
): void => {
  if (e.id === s.id || ctx.removed.has(e.id) || e.colorName === s.colorName) {
    return;
  }
  const dx = wrapDelta(s.x, e.x, ARENA.w);
  const dy = wrapDelta(s.y, e.y, ARENA.h);
  const d2 = dx * dx + dy * dy;
  if (d2 >= FORCEFIELD_RADIUS * FORCEFIELD_RADIUS || d2 < 1e-3) return;
  const d = Math.sqrt(d2);
  const push = FORCEFIELD_PUSH * (1 - d / FORCEFIELD_RADIUS) * steps;
  e.vx += (dx / d) * push;
  e.vy += (dy / d) * push;
  if (e.hitCooldown > 0) return;
  hit(ctx, e, FORCEFIELD_DAMAGE, "melee", s.id);
  e.hitCooldown = HIT_COOLDOWN;
  if (e.hp <= 0) {
    ctx.score[s.colorName] += SCORE_KILL;
    killShip(ctx, e);
  }
};

/** Force-field carriers push and zap nearby enemies with a damage aura. */
export const applyForceFieldAuras = (ctx: TickCtx, nbr: NbrLists): void => {
  const { moved, removed, steps } = ctx;
  for (let i = 0; i < moved.length; i++) {
    const s = moved[i];
    if (removed.has(s.id) || s.forceFieldTime <= 0) continue;
    for (const e of othersFor(moved, nbr, i))
      forceFieldStrike(ctx, s, e, steps);
  }
};

/** Transfer fuel from carrier `s` to ally `a` if it's a thirstier ally in range. */
const shareFuelWith = (
  s: Mutable<LightCycle>,
  a: Mutable<LightCycle>,
  removed: Set<number>,
  reserve: number,
  steps: number,
): void => {
  if (a.id === s.id || removed.has(a.id) || a.colorName !== s.colorName) return;
  if (a.fuel >= a.maxFuel) return;
  if (!within(s.x, s.y, a.x, a.y, FUEL_SHARE_RADIUS)) return;
  const give = Math.min(
    FUEL_SHARE_RATE * steps,
    s.fuel - reserve,
    a.maxFuel - a.fuel,
  );
  if (give <= 0) return;
  s.fuel -= give;
  a.fuel += give;
};

/** Carriers top up nearby thirstier allies mid-flight, keeping a reserve. */
export const shareCarrierFuel = (ctx: TickCtx, nbr: NbrLists): void => {
  const { moved, removed, steps } = ctx;
  for (let i = 0; i < moved.length; i++) {
    const s = moved[i];
    if (removed.has(s.id) || !isCarrier(s.archetype)) continue;
    const reserve = s.maxFuel * FUEL_SHARE_RESERVE;
    for (const a of othersFor(moved, nbr, i)) {
      if (s.fuel <= reserve) break;
      shareFuelWith(s, a, removed, reserve, steps);
    }
  }
};

/** Siphon fuel from one nearby enemy `e` into the carrier `s`. */
const leechFuelFrom = (
  s: Mutable<LightCycle>,
  e: Mutable<LightCycle>,
  removed: Set<number>,
  steps: number,
): void => {
  if (removed.has(e.id) || e.colorName === s.colorName) return;
  if (e.fuel <= 0) return;
  if (!within(s.x, s.y, e.x, e.y, CARRIER_LEECH_RADIUS)) return;
  const drain = Math.min(
    CARRIER_LEECH_RATE * steps,
    e.fuel,
    s.maxFuel - s.fuel,
  );
  if (drain <= 0) return;
  e.fuel -= drain;
  s.fuel += drain;
};

/** A live carrier that has unlocked the leech and still has room in its tank. */
const canLeech = (s: Mutable<LightCycle>, removed: Set<number>): boolean =>
  !removed.has(s.id) &&
  isCarrier(s.archetype) &&
  s.level >= CARRIER_LEECH_LEVEL &&
  s.fuel < s.maxFuel;

/** Veteran carriers siphon fuel from nearby enemies into their own tank. */
export const leechCarrierFuel = (ctx: TickCtx, nbr: NbrLists): void => {
  const { moved, removed, steps } = ctx;
  for (let i = 0; i < moved.length; i++) {
    const s = moved[i];
    if (!canLeech(s, removed)) continue;
    for (const e of othersFor(moved, nbr, i)) {
      if (s.fuel >= s.maxFuel) break;
      leechFuelFrom(s, e, removed, steps);
    }
  }
};

/**
 * Merge a scout's *completed*-base raid credit into an ally's tally: for each
 * enemy base the scout has finished, credit the ally up to its own requirement.
 * Returns a fresh baseHits map, or null when nothing changes.
 */
const mergedRaidCredit = (
  scout: Mutable<LightCycle>,
  ally: Mutable<LightCycle>,
): Record<string, number> | null => {
  const allyNeed = baseHitsRequired(ally.level);
  const scoutNeed = baseHitsRequired(scout.level);
  let next: Record<string, number> | null = null;
  for (const base of TEAM_BASES) {
    if (base.name === scout.colorName) continue;
    if ((scout.baseHits[base.name] ?? 0) < scoutNeed) continue; // not finished
    if ((ally.baseHits[base.name] ?? 0) >= allyNeed) continue; // already there
    next = next ?? { ...ally.baseHits };
    next[base.name] = allyNeed;
  }
  return next;
};

/** Copy a scout's completed-raid intel onto one same-team ally in range. */
const shareReconWith = (
  scout: Mutable<LightCycle>,
  ally: Mutable<LightCycle>,
  removed: Set<number>,
): void => {
  if (ally.id === scout.id || removed.has(ally.id)) return;
  if (ally.colorName !== scout.colorName || ally.level >= MAX_LEVEL) return;
  // L5 capstone: an ace scout broadcasts raid intel map-wide (Infinity reach),
  // so a whole team can inherit its finished raids from anywhere.
  const reach = scout.level >= MAX_LEVEL ? Infinity : RECON_SHARE_RADIUS;
  if (!within(scout.x, scout.y, ally.x, ally.y, reach)) return;
  const merged = mergedRaidCredit(scout, ally);
  if (merged) ally.baseHits = merged;
};

/** Scouts broadcast their completed-raid progress to nearby same-team allies. */
export const shareReconIntel = (ctx: TickCtx, nbr: NbrLists): void => {
  const { moved, removed } = ctx;
  for (let i = 0; i < moved.length; i++) {
    const s = moved[i];
    if (removed.has(s.id) || !isRecon(s.archetype)) continue;
    // An L5 ace scout broadcasts map-wide (Infinity reach) → must scan every
    // ship; only the range-limited lower ranks can use the neighbour list.
    const others = s.level >= MAX_LEVEL ? moved : othersFor(moved, nbr, i);
    for (const a of others) shareReconWith(s, a, removed);
  }
};

/** Weapons, pickups, portals, mines, home base, and force-field auras. */
export const resolveInteractions = (
  ctx: TickCtx,
  motion: MotionState,
  interactions: InteractionState,
) => {
  const { moved, removed, steps } = ctx;
  const { bubbles, mines, bullets, missiles, drones } = motion;
  const { takenPickups } = interactions;
  let seed = ctx.seed;
  let { bulletId, missileId, mineId } = motion;

  for (const s of moved) {
    if (removed.has(s.id)) continue;
    bulletId = fireWeapon(ctx, s, bullets, bulletId);
    [missileId, seed] = fireMissile(ctx, s, missiles, missileId, seed);
    seed = fireArc(ctx, s, seed);
    missileId = collectPickups(
      ctx,
      s,
      bubbles,
      takenPickups,
      missiles,
      missileId,
    );
    healAtPad(s, steps);
    finishAtCenterPad(ctx, s, steps);
    pullTowardPortalHorizon(s, steps);
    applyBaseGravity(ctx, s, steps);
    applyStarGravity(s, steps);
    teleportThroughPortal(s);
    [mineId, seed] = dropMine(ctx, s, mines, mineId, seed, steps);
    dockAtHomeBase(ctx, s, steps);
  }

  // Escort drones auto-fire at the nearest enemy in range (bolts go through the
  // normal bullet pipeline, so they hit/credit like any bolt).
  for (const d of drones) {
    if (d.fireCooldown > 0) continue;
    const foe = nearestEnemyToDrone(d, moved, removed);
    if (!foe) continue;
    bullets.push(spawnDroneBolt(bulletId, d, foe.x, foe.y));
    bulletId += 1;
    d.fireCooldown = DRONE_FIRE_COOLDOWN;
  }

  // One neighbour grid over the (now settled) ship positions for every aura pass.
  const nbr = gridNeighbors(moved, ARENA, AURA_BAND);
  applyForceFieldAuras(ctx, nbr);
  shareCarrierFuel(ctx, nbr);
  leechCarrierFuel(ctx, nbr);
  shareReconIntel(ctx, nbr);

  ctx.seed = seed;
  motion.bulletId = bulletId;
  motion.missileId = missileId;
  motion.mineId = mineId;
};

/** Asteroids that hop through a portal mouth and reappear at the other one. */
const hopAsteroidsThroughPortals = (
  rocks: Mutable<Asteroid>[],
  removedRocks: Set<number>,
): void => {
  for (const r of rocks) {
    if (removedRocks.has(r.id) || r.portalCooldown > 0) continue;
    for (let g = 0; g < 2; g++) {
      const from = PORTALS[g];
      if (within(r.x, r.y, from.x, from.y, from.r)) {
        const to = PORTALS[1 - g];
        const [ux, uy] = normalize([r.vx, r.vy]);
        r.x = wrap(to.x + ux * (to.r + r.size + 2), ARENA.w);
        r.y = wrap(to.y + uy * (to.r + r.size + 2), ARENA.h);
        r.portalCooldown = PORTAL_COOLDOWN;
        break;
      }
    }
  }
};

/** Detonate `m` on `s` if they're touching; returns whether it went off. */
const detonateOnContact = (
  ctx: TickCtx,
  m: Mutable<Mine>,
  s: Mutable<LightCycle>,
  removedMines: Set<number>,
): boolean => {
  if (ctx.removed.has(s.id) || s.colorName === m.team) return false;
  if (!within(s.x, s.y, m.x, m.y, MINE_RADIUS)) return false;
  removedMines.add(m.id);
  ctx.burstAt.push({
    x: Math.floor(m.x),
    y: Math.floor(m.y),
    kind: BURST_DETONATION,
  });
  if (s.hitCooldown <= 0) {
    hit(ctx, s, MINE_DAMAGE);
    s.hitCooldown = HIT_COOLDOWN;
    if (s.hp <= 0) killShip(ctx, s);
  }
  return true;
};

/** Mines that have finished arming detonate on the first enemy ship that touches them. */
const detonateArmedMines = (
  ctx: TickCtx,
  mines: Mutable<Mine>[],
  removedMines: Set<number>,
): void => {
  for (const m of mines) {
    if (removedMines.has(m.id) || m.arm > 0) continue;
    for (const s of ctx.moved) {
      if (detonateOnContact(ctx, m, s, removedMines)) break;
    }
  }
};

/** Asteroid portal hops and armed mine detonations. */
export const resolveFieldEffects = (
  ctx: TickCtx,
  motion: MotionState,
  interactions: InteractionState,
  hazards: HazardState,
) => {
  const { rocks, mines } = motion;
  const { removedMines } = interactions;
  const { removedRocks } = hazards;

  hopAsteroidsThroughPortals(rocks, removedRocks);
  detonateArmedMines(ctx, mines, removedMines);
};
