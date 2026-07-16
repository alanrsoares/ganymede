import { normalize, wrapDelta } from "~/engine/physics";
import type { Seed } from "~/engine/rng";
import { nextFloat } from "~/engine/rng";
import {
  ARCADE_DOCK_HEAL_MULT,
  ARCADE_REPAIR_PING_GENS,
  BASE_HEAL_RATE,
  BASE_HORIZON,
  BASE_MAX_HP,
  BASE_PULL,
  BASE_PUSH,
  BASE_RADIUS,
  CENTER_HORIZON,
  CENTER_PULL,
  centerPadPhase,
  FUEL_REFILL,
  HIT_COOLDOWN,
  HOME_RADIUS,
  hasRaidedAllEnemyBases,
  MINE_ARM,
  MINE_DAMAGE,
  MINE_DROP_CHANCE,
  MINE_LIFE,
  MINE_RADIUS,
  PAD_HEAL,
  PORTAL_COOLDOWN,
  PORTAL_HORIZON,
  PORTAL_PULL,
  SHIELD_BASE_REGEN,
  shipRadius,
  wrap,
} from "../../factory";
import { within } from "../../math";
import {
  ARENA,
  type Asteroid,
  type Base,
  BURST_DETONATION,
  BURST_SHIELD,
  baseByName,
  CENTER_PAD,
  HEAL_PADS,
  type LightCycle,
  MAX_LEVEL,
  type Mine,
  type Mutable,
  PORTALS,
  TEAM_BASES,
} from "../../types";
import { hit, killShip, promote, type TickCtx } from "../context";
import type { HazardState } from "../hazard-collisions";
import type { MotionState } from "../motion";
import type { InteractionState } from "./state";

/** Heal from the first overlapping heal pad, if any. */
export const healAtPad = (s: Mutable<LightCycle>, steps: number): void => {
  if (s.hp >= s.maxHp) return;
  for (const pad of HEAL_PADS) {
    if (within(s.x, s.y, pad.x, pad.y, pad.r)) {
      s.hp = Math.min(s.maxHp, s.hp + PAD_HEAL * steps);
      break;
    }
  }
};

/** Gravitational pull toward a portal's event horizon. */
export const pullTowardPortalHorizon = (
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
export const applyBaseGravity = (
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
export const applyStarGravity = (
  s: Mutable<LightCycle>,
  steps: number,
): void => {
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
export const teleportThroughPortal = (s: Mutable<LightCycle>): void => {
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
export const dropMine = (
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

/**
 * Docking repairs a damaged home base, but never revives a razed one (hp 0):
 * a destroyed base stays destroyed and its team is eliminated. Arcade differs
 * on both ends: it ignores the sudden-death cutoff (arcade configs set
 * reinforceGens to 0, which would otherwise disable repair from tick one) and
 * patches faster — the pilot is the only mechanic on staff, so a pit stop must
 * be seconds, not a wave. A periodic shield-ring pulse makes the repair
 * visible while HP is actually climbing.
 */
const repairHomeBase = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  home: Base,
  steps: number,
): void => {
  const arcade = ctx.world.arcade !== null;
  if ((!arcade && ctx.suddenDeath) || ctx.baseHp[s.colorName] <= 0) return;
  const before = ctx.baseHp[s.colorName];
  const rate = BASE_HEAL_RATE * (arcade ? ARCADE_DOCK_HEAL_MULT : 1);
  ctx.baseHp[s.colorName] = Math.min(BASE_MAX_HP, before + rate * steps);
  if (
    arcade &&
    ctx.baseHp[s.colorName] > before &&
    ctx.world.age % ARCADE_REPAIR_PING_GENS < steps
  ) {
    ctx.burstAt.push({
      x: home.x,
      y: home.y,
      kind: BURST_SHIELD,
      rgb: s.color,
    });
  }
};

/** Refill shield/mines/fuel and top up the home base while docked. */
export const dockAtHomeBase = (
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
  repairHomeBase(ctx, s, home, steps);
};

/**
 * The center pad: heals + regenerates shield for any ship over it, and — if the
 * ship has already raided every alive enemy base — cashes in the level-up. The
 * raid tally then resets. This is the "fly over center to finish" half of the
 * level goal (the raid half is tallied in creditBaseHit).
 */
export const finishAtCenterPad = (
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
