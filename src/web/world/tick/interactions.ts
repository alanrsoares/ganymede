import { normalize, wrapDelta } from "../../engine/physics";
import type { Seed } from "../../engine/rng";
import { nextFloat } from "../../engine/rng";
import {
  acquireTarget,
  BASE_HEAL_RATE,
  BASE_LEVELUP_CHANCE,
  BASE_MAX_HP,
  BOOST_DURATION,
  CLOAK_DURATION,
  carriesMissiles,
  EMP_DAMAGE,
  EMP_RADIUS,
  FIRE_RANGE,
  FORCEFIELD_DAMAGE,
  FORCEFIELD_DURATION,
  FORCEFIELD_PUSH,
  FORCEFIELD_RADIUS,
  FUEL_REFILL,
  FUEL_SHARE_RADIUS,
  FUEL_SHARE_RATE,
  FUEL_SHARE_RESERVE,
  fireCooldownFor,
  HIT_COOLDOWN,
  HOME_RADIUS,
  isCarrier,
  MINE_ARM,
  MINE_DAMAGE,
  MINE_DROP_CHANCE,
  MINE_LIFE,
  MINE_RADIUS,
  MISSILE_FIRE_CHANCE,
  MISSILE_MIN_LEVEL,
  MISSILE_RANGE,
  maxHpFor,
  minesFor,
  OVERCHARGE_DURATION,
  OVERCHARGE_MULT,
  PAD_HEAL,
  PICKUP_RADIUS,
  PORTAL_COOLDOWN,
  PORTAL_HORIZON,
  PORTAL_PULL,
  SCORE_KILL,
  SCORE_MERGE,
  SCORE_PICKUP,
  SHIELD_BASE_REGEN,
  shieldForLevel,
  shipRadius,
  spawnBullet,
  spawnMissile,
  toroidalDist,
  wrap,
} from "../factory";
import {
  type Asteroid,
  BURST_DETONATION,
  BURST_EXPLOSION,
  BURST_MUZZLE,
  type Bullet,
  baseByName,
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

/** Bolt at the nearest enemy ship in range, else strafe the nearest alive enemy base. */
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

  const bolt = spawnBullet(bulletId, s, aim.x, aim.y);
  bullets.push(bolt);
  s.fireCooldown =
    fireCooldownFor(s.archetype, s.level) *
    (s.overchargeTime > 0 ? OVERCHARGE_MULT : 1);
  const muzzle = shipRadius(s.level) + 1;
  const ax = Math.sin(bolt.angle);
  const ay = Math.cos(bolt.angle);
  ctx.burstAt.push({
    x: Math.floor(wrap(s.x + ax * muzzle, GRID_W)),
    y: Math.floor(wrap(s.y + ay * muzzle, GRID_H)),
    kind: BURST_MUZZLE,
    rgb: s.color,
    rot: bolt.angle,
  });
  return bulletId + 1;
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

  missiles.push(spawnMissile(missileId, s, tgt.ship));
  return [missileId + 1, nextSeed];
};

/** EMP pickup: damage (and possibly kill) every enemy ship within blast radius. */
const triggerEmpBlast = (ctx: TickCtx, s: Mutable<LightCycle>): void => {
  const { moved, removed } = ctx;
  for (const e of moved) {
    if (removed.has(e.id) || e.colorName === s.colorName) continue;
    const ex = toroidalDist(s.x, e.x, GRID_W);
    const ey = toroidalDist(s.y, e.y, GRID_H);
    if (ex * ex + ey * ey >= EMP_RADIUS * EMP_RADIUS) continue;
    ctx.burstAt.push({
      x: Math.floor(e.x),
      y: Math.floor(e.y),
      kind: BURST_DETONATION,
    });
    hit(ctx, e, EMP_DAMAGE);
    if (e.hp <= 0) {
      ctx.score[s.colorName] += SCORE_KILL;
      killShip(ctx, e);
    }
  }
};

/** Apply one collected pickup's effect by kind (heal/shield/boost/.../EMP AoE). */
const applyPickup = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  kind: number,
): void => {
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
    default:
      triggerEmpBlast(ctx, s);
  }
};

/** Collect every unclaimed pickup within radius and apply its effect. */
const collectPickups = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  bubbles: Mutable<Pickup>[],
  takenPickups: Set<number>,
): void => {
  for (const p of bubbles) {
    if (takenPickups.has(p.id)) continue;
    const dx = toroidalDist(s.x, p.x, GRID_W);
    const dy = toroidalDist(s.y, p.y, GRID_H);
    if (dx * dx + dy * dy >= PICKUP_RADIUS * PICKUP_RADIUS) continue;
    takenPickups.add(p.id);
    ctx.score[s.colorName] += SCORE_PICKUP;
    applyPickup(ctx, s, p.kind);
  }
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

/** Refill shield/mines/fuel and top up the home base while docked; roll for a free level-up. */
const dockAtHomeBase = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  steps: number,
  seed: Seed,
): Seed => {
  const home = baseByName.get(s.colorName);
  if (!home) return seed;
  const dx = toroidalDist(s.x, home.x, GRID_W);
  const dy = toroidalDist(s.y, home.y, GRID_H);
  if (dx * dx + dy * dy >= HOME_RADIUS * HOME_RADIUS) return seed;

  s.shield = Math.min(
    s.maxShield,
    s.shield + s.maxShield * SHIELD_BASE_REGEN * steps,
  );
  s.mines = s.maxMines;
  s.fuel = Math.min(s.maxFuel, s.fuel + FUEL_REFILL * steps);
  ctx.baseHp[s.colorName] = Math.min(
    BASE_MAX_HP,
    ctx.baseHp[s.colorName] + BASE_HEAL_RATE * steps,
  );
  if (s.level >= MAX_LEVEL) return seed;

  const [roll, nextSeed] = nextFloat(seed);
  if (roll >= BASE_LEVELUP_CHANCE * steps) return nextSeed;

  s.level += 1;
  s.maxHp = maxHpFor(s.archetype, s.level);
  s.hp = s.maxHp;
  s.maxShield = shieldForLevel(s.level);
  s.shield = s.maxShield;
  s.maxMines = minesFor(s.archetype, s.level);
  s.mines = s.maxMines;
  ctx.score[s.colorName] += SCORE_MERGE;
  ctx.burstAt.push({
    x: Math.floor(s.x),
    y: Math.floor(s.y),
    kind: BURST_EXPLOSION,
  });
  return nextSeed;
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
  hit(ctx, e, FORCEFIELD_DAMAGE);
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
    collectPickups(ctx, s, bubbles, takenPickups);
    healAtPad(s, steps);
    pullTowardPortalHorizon(s, steps);
    teleportThroughPortal(s);
    [mineId, seed] = dropMine(ctx, s, mines, mineId, seed, steps);
    seed = dockAtHomeBase(ctx, s, steps, seed);
  }

  applyForceFieldAuras(ctx);
  shareCarrierFuel(ctx);

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
