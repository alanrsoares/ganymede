import { normalize, wrapDelta } from "~/engine/physics";
import type { Seed } from "~/engine/rng";
import { nextFloat } from "~/engine/rng";
import {
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
  CLOAK_DURATION,
  carriesMissiles,
  centerPadPhase,
  EMP_MISSILE_LOCK,
  FIRE_RANGE,
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
  PORTAL_COOLDOWN,
  PORTAL_HORIZON,
  PORTAL_PULL,
  RECON_SHARE_RADIUS,
  SCORE_KILL,
  SCORE_PICKUP,
  SHIELD_BASE_REGEN,
  shipRadius,
  spawnBullet,
  spawnEmpMissile,
  spawnMissile,
  toroidalDist,
  type WeaponProfile,
  weaponFor,
  wrap,
} from "../factory";
import {
  type Asteroid,
  BURST_DETONATION,
  BURST_MUZZLE,
  type Bullet,
  baseByName,
  CENTER_PAD,
  GRID_H,
  GRID_W,
  HEAL_PADS,
  type LightCycle,
  MAX_LEVEL,
  type Mine,
  type Missile,
  type Mutable,
  type Pickup,
  PORTALS,
  TEAM_BASES,
} from "../types";
import { hit, killShip, promote, type TickCtx } from "./context";
import type { HazardState } from "./hazard-collisions";
import type { MotionState } from "./motion";

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
  let best = FIRE_RANGE * FIRE_RANGE;
  let tx: number | null = null;
  let ty: number | null = null;
  for (const base of TEAM_BASES) {
    if (base.name === s.colorName || ctx.baseHp[base.name] <= 0) continue;
    const dx = toroidalDist(s.x, base.x, GRID_W);
    const dy = toroidalDist(s.y, base.y, GRID_H);
    const d2 = dx * dx + dy * dy;
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
    x: Math.floor(wrap(s.x + Math.sin(angle) * muzzle, GRID_W)),
    y: Math.floor(wrap(s.y + Math.cos(angle) * muzzle, GRID_H)),
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
const fireWeapon = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  bullets: Mutable<Bullet>[],
  bulletId: number,
): number => {
  const { moved, removed } = ctx;
  if (!(s.fuel > 0 && s.fireCooldown <= 0)) return bulletId;

  const target = acquireTarget(s, moved, FIRE_RANGE, removed);
  // No enemy ship in range → strafe the nearest alive enemy base (the raid).
  const aim: Aim | null =
    target && target.dist <= FIRE_RANGE
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
    const dx = toroidalDist(s.x, a.x, GRID_W);
    const dy = toroidalDist(s.y, a.y, GRID_H);
    if (dx * dx + dy * dy >= FUEL_CELL_PUMP_RADIUS * FUEL_CELL_PUMP_RADIUS) {
      continue;
    }
    a.fuel = Math.min(a.maxFuel, a.fuel + FUEL_CELL_YIELD);
  }
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
    // Fuel cells are a carrier-only resource — non-carriers coast through and
    // leave them floating for a carrier to harvest.
    if (p.kind === FUEL_CELL_KIND && !isCarrier(s.archetype)) continue;
    const dx = toroidalDist(s.x, p.x, GRID_W);
    const dy = toroidalDist(s.y, p.y, GRID_H);
    if (dx * dx + dy * dy >= PICKUP_RADIUS * PICKUP_RADIUS) continue;
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
    const dx = toroidalDist(s.x, pad.x, GRID_W);
    const dy = toroidalDist(s.y, pad.y, GRID_H);
    if (dx * dx + dy * dy < pad.r * pad.r) {
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
    const gx = wrapDelta(s.x, g.x, GRID_W);
    const gy = wrapDelta(s.y, g.y, GRID_H);
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
    const gx = wrapDelta(s.x, b.x, GRID_W);
    const gy = wrapDelta(s.y, b.y, GRID_H);
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

/** Step through a portal mouth to the other one, if standing in it and off cooldown. */
const teleportThroughPortal = (s: Mutable<LightCycle>): void => {
  if (s.portalCooldown > 0) return;
  for (let g = 0; g < 2; g++) {
    const from = PORTALS[g];
    const dx = toroidalDist(s.x, from.x, GRID_W);
    const dy = toroidalDist(s.y, from.y, GRID_H);
    if (dx * dx + dy * dy < from.r * from.r) {
      const to = PORTALS[1 - g];
      s.x = wrap(to.x + s.dx * (to.r + 2), GRID_W);
      s.y = wrap(to.y + s.dy * (to.r + 2), GRID_H);
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
  if (!(s.fuel > 0 && s.mines > 0)) return [mineId, seed];
  const [roll, nextSeed] = nextFloat(seed);
  if (roll >= MINE_DROP_CHANCE * steps) return [mineId, nextSeed];

  s.mines -= 1;
  const back = shipRadius(s.level) + 3;
  mines.push({
    id: mineId,
    x: wrap(s.x - s.dx * back, GRID_W),
    y: wrap(s.y - s.dy * back, GRID_H),
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
  const dx = toroidalDist(s.x, home.x, GRID_W);
  const dy = toroidalDist(s.y, home.y, GRID_H);
  if (dx * dx + dy * dy >= HOME_RADIUS * HOME_RADIUS) return;

  s.shield = Math.min(
    s.maxShield,
    s.shield + s.maxShield * SHIELD_BASE_REGEN * steps,
  );
  s.mines = s.maxMines;
  s.fuel = Math.min(s.maxFuel, s.fuel + FUEL_REFILL * steps);
  if (!ctx.suddenDeath) {
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
  const dx = toroidalDist(s.x, CENTER_PAD.x, GRID_W);
  const dy = toroidalDist(s.y, CENTER_PAD.y, GRID_H);
  if (dx * dx + dy * dy >= CENTER_PAD.r * CENTER_PAD.r) return;
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
  const dx = wrapDelta(s.x, e.x, GRID_W);
  const dy = wrapDelta(s.y, e.y, GRID_H);
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
const applyForceFieldAuras = (ctx: TickCtx): void => {
  const { moved, removed, steps } = ctx;
  for (const s of moved) {
    if (removed.has(s.id) || s.forceFieldTime <= 0) continue;
    for (const e of moved) forceFieldStrike(ctx, s, e, steps);
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
  const dx = toroidalDist(s.x, a.x, GRID_W);
  const dy = toroidalDist(s.y, a.y, GRID_H);
  if (dx * dx + dy * dy >= FUEL_SHARE_RADIUS * FUEL_SHARE_RADIUS) return;
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
const shareCarrierFuel = (ctx: TickCtx): void => {
  const { moved, removed, steps } = ctx;
  for (const s of moved) {
    if (removed.has(s.id) || !isCarrier(s.archetype)) continue;
    const reserve = s.maxFuel * FUEL_SHARE_RESERVE;
    for (const a of moved) {
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
  const dx = toroidalDist(s.x, e.x, GRID_W);
  const dy = toroidalDist(s.y, e.y, GRID_H);
  if (dx * dx + dy * dy >= CARRIER_LEECH_RADIUS * CARRIER_LEECH_RADIUS) return;
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
const leechCarrierFuel = (ctx: TickCtx): void => {
  const { moved, removed, steps } = ctx;
  for (const s of moved) {
    if (!canLeech(s, removed)) continue;
    for (const e of moved) {
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
  const dx = toroidalDist(scout.x, ally.x, GRID_W);
  const dy = toroidalDist(scout.y, ally.y, GRID_H);
  // L5 capstone: an ace scout broadcasts raid intel map-wide (Infinity reach),
  // so a whole team can inherit its finished raids from anywhere.
  const reach = scout.level >= MAX_LEVEL ? Infinity : RECON_SHARE_RADIUS;
  if (dx * dx + dy * dy >= reach * reach) return;
  const merged = mergedRaidCredit(scout, ally);
  if (merged) ally.baseHits = merged;
};

/** Scouts broadcast their completed-raid progress to nearby same-team allies. */
const shareReconIntel = (ctx: TickCtx): void => {
  const { moved, removed } = ctx;
  for (const s of moved) {
    if (removed.has(s.id) || !isRecon(s.archetype)) continue;
    for (const a of moved) shareReconWith(s, a, removed);
  }
};

/** Weapons, pickups, portals, mines, home base, and force-field auras. */
export const resolveInteractions = (
  ctx: TickCtx,
  motion: MotionState,
  interactions: InteractionState,
) => {
  const { moved, removed, steps } = ctx;
  const { bubbles, mines, bullets, missiles } = motion;
  const { takenPickups } = interactions;
  let seed = ctx.seed;
  let { bulletId, missileId, mineId } = motion;

  for (const s of moved) {
    if (removed.has(s.id)) continue;
    bulletId = fireWeapon(ctx, s, bullets, bulletId);
    [missileId, seed] = fireMissile(ctx, s, missiles, missileId, seed);
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
    teleportThroughPortal(s);
    [mineId, seed] = dropMine(ctx, s, mines, mineId, seed, steps);
    dockAtHomeBase(ctx, s, steps);
  }

  applyForceFieldAuras(ctx);
  shareCarrierFuel(ctx);
  leechCarrierFuel(ctx);
  shareReconIntel(ctx);

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
      const dx = toroidalDist(r.x, from.x, GRID_W);
      const dy = toroidalDist(r.y, from.y, GRID_H);
      if (dx * dx + dy * dy < from.r * from.r) {
        const to = PORTALS[1 - g];
        const [ux, uy] = normalize([r.vx, r.vy]);
        r.x = wrap(to.x + ux * (to.r + r.size + 2), GRID_W);
        r.y = wrap(to.y + uy * (to.r + r.size + 2), GRID_H);
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
  const dx = toroidalDist(s.x, m.x, GRID_W);
  const dy = toroidalDist(s.y, m.y, GRID_H);
  if (dx * dx + dy * dy >= MINE_RADIUS * MINE_RADIUS) return false;
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
