import { nextInt, nextRange } from "~/engine/rng";
import {
  BOOST_DURATION,
  CLOAK_DURATION,
  DRONE_COUNT,
  DRONE_DURATION,
  DRONE_FIRE_COOLDOWN,
  DRONE_FIRE_RANGE,
  DRONE_ORBIT_RADIUS,
  FORCEFIELD_DURATION,
  FUEL_CELL_KIND,
  FUEL_CELL_PUMP_RADIUS,
  FUEL_CELL_YIELD,
  isCarrier,
  OVERCHARGE_DURATION,
  PICKUP_RADIUS,
  rollShip,
  SCORE_PICKUP,
  shipRadius,
  wrap,
} from "../../factory";
import { distSq, within } from "../../math";
import {
  ARENA,
  DRONE_KIND,
  type Drone,
  type LightCycle,
  type Missile,
  MUSTER_KIND,
  type Mutable,
  type Pickup,
} from "../../types";
import { promote, type TickCtx } from "../context";
import { fireEmpMissile } from "./weapons";

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

// Reinforcement power-up (arcade only): collector's team gains 1–2 AI allies
// mustered at pickup, queued into ctx.spawned so finalize commits them (still
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
export const nearestEnemyToDrone = (
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
export const collectPickups = (
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
