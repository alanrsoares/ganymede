import { normalize, wrapDelta } from "../engine/physics";
import { hasRaidedAllEnemyBases } from "./math";
import {
  ALIGN_GAIN,
  AVOID_GAIN,
  AVOID_RADIUS,
  baseHitsRequired,
  CENTERPAD_SEEK_GAIN,
  CENTERPAD_SEEK_RADIUS,
  CENTERPAD_SEEK_THRESH,
  COHERE_GAIN,
  ENGAGE_GAIN,
  ENGAGE_RADIUS,
  FLOCK_RADIUS,
  FUEL_BURN,
  FUEL_LOW_FRAC,
  FUEL_RETURN_GAIN,
  FUEL_SAFETY,
  FUEL_SHARE_RESERVE,
  HEAL_HP_THRESHOLD,
  HEAL_SEEK_GAIN,
  HEAL_SEEK_RADIUS,
  isCarrier,
  KITE_DIST,
  OBJECTIVE_GAIN,
  OBJECTIVE_RADIUS,
  PICKUP_SEEK_GAIN,
  PICKUP_SEEK_RADIUS,
  pickupWant,
  RALLY_ARRIVE_RADIUS,
  RALLY_GAIN,
  RALLY_RADIUS,
  WANDER_GAIN,
} from "./tuning";
import {
  type Asteroid,
  baseByName,
  CENTER_PAD,
  GRID_H,
  GRID_W,
  HEAL_PADS,
  type LightCycle,
  type Pickup,
  PORTALS,
  type RallyBeacon,
  TEAM_BASES,
} from "./types";

/** Separation term: repel `self` from anything close and ahead (ships + rocks). */
const steerSeparation = (
  self: LightCycle,
  ships: readonly LightCycle[],
  rocks: readonly Asteroid[],
  level: number,
): [number, number] => {
  const sepGain = AVOID_GAIN[level - 1] ?? 0;
  const sepR = AVOID_RADIUS[level - 1] ?? 0;
  let sx = 0;
  let sy = 0;
  const react = (ox: number, oy: number) => {
    const ax = wrapDelta(ox, self.x, GRID_W); // vector obstacle -> self
    const ay = wrapDelta(oy, self.y, GRID_H);
    const dist = Math.hypot(ax, ay);
    if (dist < 1e-3 || dist > sepR) return;
    if (self.dx * -ax + self.dy * -ay < 0) return; // ignore what's behind
    const w = (1 - dist / sepR) / dist;
    sx += ax * w;
    sy += ay * w;
  };
  if (sepGain > 0) {
    for (const o of ships) if (o.id !== self.id) react(o.x, o.y);
    for (const r of rocks) react(r.x, r.y);
  }
  return [sx * sepGain, sy * sepGain];
};

/**
 * Alignment + cohesion terms with same-team neighbors in range. Returns the
 * four deltas [alignDx, alignDy, cohereDx, cohereDy] in the exact sequence
 * they're folded into the accumulator, so caller-side summation stays
 * bit-identical to the original inline code.
 */
/** Should the alignment/cohesion term run at all for this rank? */
const wantsAlignCohere = (
  alignGain: number,
  cohereGain: number,
  flockR: number,
): boolean => flockR > 0 && (alignGain > 0 || cohereGain > 0);

/** Sum velocity + offset of same-team neighbors within `flockR` of `self`. */
const collectSquadmates = (
  self: LightCycle,
  ships: readonly LightCycle[],
  flockR: number,
): { vx: number; vy: number; cx: number; cy: number; n: number } => {
  let vx = 0;
  let vy = 0;
  let cx = 0;
  let cy = 0;
  let n = 0;
  const flockR2 = flockR * flockR;
  for (const o of ships) {
    if (o.id === self.id || o.colorName !== self.colorName) continue;
    const dx = wrapDelta(self.x, o.x, GRID_W); // self -> neighbor
    const dy = wrapDelta(self.y, o.y, GRID_H);
    if (dx * dx + dy * dy > flockR2) continue;
    vx += o.vx;
    vy += o.vy;
    cx += dx;
    cy += dy;
    n += 1;
  }
  return { vx, vy, cx, cy, n };
};

const steerAlignCohere = (
  self: LightCycle,
  ships: readonly LightCycle[],
  level: number,
): [number, number, number, number] => {
  const alignGain = ALIGN_GAIN[level - 1] ?? 0;
  const cohereGain = COHERE_GAIN[level - 1] ?? 0;
  const flockR = FLOCK_RADIUS[level - 1] ?? 0;
  if (!wantsAlignCohere(alignGain, cohereGain, flockR)) return [0, 0, 0, 0];
  const { vx, vy, cx, cy, n } = collectSquadmates(self, ships, flockR);
  if (n === 0) return [0, 0, 0, 0];
  const [ahx, ahy] = normalize([vx / n, vy / n], [self.dx, self.dy]);
  return [
    (ahx - self.dx) * alignGain, // steer heading toward squad heading
    (ahy - self.dy) * alignGain,
    (cx / n) * cohereGain, // drift toward squad center
    (cy / n) * cohereGain,
  ];
};

/**
 * Pursuit term: hunt the nearest enemy inside engage range. Aces with a kite
 * band hold their standoff distance (approach beyond it, retreat inside it);
 * lower ranks just bore straight in.
 */
/** Nearest enemy within `rangeSq` of `self` as an offset vector, or null. */
const nearestEnemyOffset = (
  self: LightCycle,
  ships: readonly LightCycle[],
  rangeSq: number,
): { ex: number; ey: number; d2: number } | null => {
  let ex = 0;
  let ey = 0;
  let bestD2 = rangeSq;
  let locked = false;
  for (const o of ships) {
    if (o.id === self.id || o.colorName === self.colorName) continue;
    const dx = wrapDelta(self.x, o.x, GRID_W); // self -> enemy
    const dy = wrapDelta(self.y, o.y, GRID_H);
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      ex = dx;
      ey = dy;
      locked = true;
    }
  }
  return locked ? { ex, ey, d2: bestD2 } : null;
};

const steerPursuit = (
  self: LightCycle,
  ships: readonly LightCycle[],
  level: number,
): [number, number] => {
  const engageGain = ENGAGE_GAIN[level - 1] ?? 0;
  const engageR = ENGAGE_RADIUS[level - 1] ?? 0;
  const kiteDist = KITE_DIST[level - 1] ?? 0;
  if (!(engageGain > 0 && engageR > 0)) return [0, 0];
  const hit = nearestEnemyOffset(self, ships, engageR * engageR);
  if (!hit) return [0, 0];
  const dist = Math.sqrt(hit.d2) || 1;
  const ux = hit.ex / dist;
  const uy = hit.ey / dist;
  // sign > 0 pulls toward the target, < 0 pushes away (kiting too close).
  const dir = kiteDist > 0 ? Math.sign(dist - kiteDist) : 1;
  return [ux * engageGain * dir, uy * engageGain * dir];
};

/**
 * Objective seeking (rank-gated): chase the most-wanted power-up in sense
 * range. Matching-need bubbles (heal when hurt, shield when down) read
 * closer, so the pick reflects the ship's deficit rather than raw distance.
 */
const steerPickupSeek = (
  self: LightCycle,
  pickups: readonly Pickup[],
  level: number,
): [number, number] => {
  const pickGain = PICKUP_SEEK_GAIN[level - 1] ?? 0;
  const pickR = PICKUP_SEEK_RADIUS[level - 1] ?? 0;
  if (!(pickGain > 0 && pickR > 0)) return [0, 0];
  let bx = 0;
  let by = 0;
  let bestWant = 0;
  let best = Infinity;
  let found = false;
  const pickR2 = pickR * pickR;
  for (const p of pickups) {
    const dx = wrapDelta(self.x, p.x, GRID_W); // self -> bubble
    const dy = wrapDelta(self.y, p.y, GRID_H);
    const d2 = dx * dx + dy * dy;
    if (d2 > pickR2) continue;
    const want = pickupWant(self, p.kind);
    const score = d2 / want; // wanted kinds feel nearer
    if (score < best) {
      best = score;
      bestWant = want;
      bx = dx;
      by = dy;
      found = true;
    }
  }
  if (!found) return [0, 0];
  // Scale the pull by how much this ship wants the bubble, so a matching-need
  // grab (heal when hurt, fuel when low) commits hard instead of losing out to
  // the pursuit/objective forces; a casual pickup stays a gentle nudge.
  const urgency = Math.min(2.4, bestWant);
  const [ux, uy] = normalize([bx, by], [self.dx, self.dy]);
  return [ux * pickGain * urgency, uy * pickGain * urgency];
};

/**
 * Self-preservation term: when HP drops below the rank's retreat threshold,
 * peel off to the nearest heal pad in range. The pull hardens as HP falls, so
 * a badly hurt ship commits to the pad instead of half-heartedly drifting.
 */
const steerHealSeek = (self: LightCycle, level: number): [number, number] => {
  const healGain = HEAL_SEEK_GAIN[level - 1] ?? 0;
  const healR = HEAL_SEEK_RADIUS[level - 1] ?? 0;
  const healThresh = HEAL_HP_THRESHOLD[level - 1] ?? 0;
  if (!(healGain > 0 && self.hp < self.maxHp * healThresh)) return [0, 0];
  let bx = 0;
  let by = 0;
  let bestD2 = healR * healR;
  let found = false;
  for (const pad of HEAL_PADS) {
    const dx = wrapDelta(self.x, pad.x, GRID_W); // self -> pad
    const dy = wrapDelta(self.y, pad.y, GRID_H);
    const d2 = dx * dx + dy * dy;
    if (d2 >= bestD2) continue;
    bestD2 = d2;
    bx = dx;
    by = dy;
    found = true;
  }
  if (!found) return [0, 0];
  const urgency = 1 - self.hp / (self.maxHp * healThresh); // 0 → 1 as HP↓
  const [ux, uy] = normalize([bx, by], [self.dx, self.dy]);
  return [ux * healGain * (0.5 + urgency), uy * healGain * (0.5 + urgency)];
};

// Worst survivability deficit (0 = topped up … 1 = empty) across hp + shield.
// Fuel is deliberately excluded: ships burn it constantly, so counting it here
// would pull them off combat toward the pad nonstop (home base + carriers handle
// refuelling). The pad still tops fuel for whoever holds it for hp/shield.
const survivalDeficit = (self: LightCycle): number => {
  const hp = 1 - self.hp / self.maxHp;
  const shield = self.maxShield > 0 ? 1 - self.shield / self.maxShield : 0;
  return Math.max(hp, shield);
};

/**
 * Recover-at-center term: a badly-hurt ship breaks for the center pad, which
 * cycles hp/fuel/shield. The pull scales with how drained the ship is, so a
 * near-dead ship commits hard while a healthy one ignores the pad.
 */
const steerCenterPadSeek = (
  self: LightCycle,
  level: number,
): [number, number] => {
  const gain = CENTERPAD_SEEK_GAIN[level - 1] ?? 0;
  const r = CENTERPAD_SEEK_RADIUS[level - 1] ?? 0;
  if (!(gain > 0 && r > 0)) return [0, 0];
  const need = survivalDeficit(self);
  if (need < CENTERPAD_SEEK_THRESH) return [0, 0];
  const dx = wrapDelta(self.x, CENTER_PAD.x, GRID_W);
  const dy = wrapDelta(self.y, CENTER_PAD.y, GRID_H);
  if (dx * dx + dy * dy > r * r) return [0, 0];
  const [ux, uy] = normalize(goalDelta(self, CENTER_PAD.x, CENTER_PAD.y), [
    self.dx,
    self.dy,
  ]);
  return [ux * gain * need, uy * gain * need];
};

/** A place a low-fuel ship can top up: its home base, or a same-team carrier with fuel to spare. */
interface FuelSource {
  x: number;
  y: number;
  dist: number;
}

/**
 * Nearest reachable fuel source for `self`: its home base, or the closest
 * same-team carrier still holding a shareable reserve (carriers refuel allies
 * mid-flight — so a thirsty ship near one need not trek all the way home).
 */
const nearestFuelSource = (
  self: LightCycle,
  ships: readonly LightCycle[],
): FuelSource | null => {
  let best: FuelSource | null = null;
  const consider = (x: number, y: number) => {
    const dist = Math.hypot(
      wrapDelta(self.x, x, GRID_W),
      wrapDelta(self.y, y, GRID_H),
    );
    if (!best || dist < best.dist) best = { x, y, dist };
  };
  const homeBase = baseByName.get(self.colorName);
  if (homeBase) consider(homeBase.x, homeBase.y);
  for (const o of ships) {
    if (o.id === self.id || o.colorName !== self.colorName) continue;
    if (!isCarrier(o.archetype) || o.fuel <= o.maxFuel * FUEL_SHARE_RESERVE) {
      continue;
    }
    consider(o.x, o.y);
  }
  return best;
};

/** Would `self` run dry before reaching `source` (with a safety margin)? Also true below the hard floor. */
const mustRefuel = (self: LightCycle, source: FuelSource): boolean => {
  const reserve = source.dist * FUEL_BURN * FUEL_SAFETY;
  return self.fuel <= Math.max(self.maxFuel * FUEL_LOW_FRAC, reserve);
};

/**
 * Portal-shortcut course (L4+): compare the straight toroidal run to the goal
 * against routing through each gate (dist to the entry gate + dist from its
 * linked exit gate to the goal). If a gate hop is shorter, steer toward that
 * entry gate — the ship dives through the portal and pops out closer.
 */
const portalShortcut = (
  self: LightCycle,
  tx: number,
  ty: number,
  wrapped: [number, number],
): [number, number] => {
  let best = Math.hypot(wrapped[0], wrapped[1]);
  let course = wrapped;
  for (let i = 0; i < PORTALS.length; i++) {
    const entry = PORTALS[i];
    const exit = PORTALS[PORTALS.length - 1 - i]; // the linked far gate
    const toEntry: [number, number] = [
      wrapDelta(self.x, entry.x, GRID_W),
      wrapDelta(self.y, entry.y, GRID_H),
    ];
    const via =
      Math.hypot(toEntry[0], toEntry[1]) +
      Math.hypot(wrapDelta(exit.x, tx, GRID_W), wrapDelta(exit.y, ty, GRID_H));
    if (via < best) {
      best = via;
      course = toEntry;
    }
  }
  return course;
};

/**
 * Course vector from `self` to a goal point, with rank-gated path smarts:
 *  - L1–2 steer straight at the goal (can take the long way round the seam);
 *  - L3+  leverage the world wrap (shortest toroidal course);
 *  - L4+  also consider a portal hop when that shortcut is nearer.
 */
export const goalDelta = (
  self: LightCycle,
  tx: number,
  ty: number,
): [number, number] => {
  if (self.level < 3) return [tx - self.x, ty - self.y];
  const wrapped: [number, number] = [
    wrapDelta(self.x, tx, GRID_W),
    wrapDelta(self.y, ty, GRID_H),
  ];
  return self.level < 4 ? wrapped : portalShortcut(self, tx, ty, wrapped);
};

/** Fuel-return term: break off toward `source` to refuel (survival trumps the raid). */
const steerFuelReturn = (
  self: LightCycle,
  source: FuelSource,
): [number, number] => {
  const [ux, uy] = normalize(goalDelta(self, source.x, source.y), [
    self.dx,
    self.dy,
  ]);
  // 0 when range-triggered while fuel is still healthy, ramping to 1 near empty.
  const urgency = Math.max(0, 1 - self.fuel / (self.maxFuel * FUEL_LOW_FRAC));
  return [
    ux * FUEL_RETURN_GAIN * (0.6 + urgency),
    uy * FUEL_RETURN_GAIN * (0.6 + urgency),
  ];
};

/** Is `base` still a valid raid target for `self` (alive, enemy, hits still owed)? */
const isRaidableBase = (
  self: LightCycle,
  base: { name: string },
  baseHp: Readonly<Record<string, number>>,
  need: number,
): boolean =>
  base.name !== self.colorName &&
  (baseHp[base.name] ?? 0) > 0 &&
  (self.baseHits[base.name] ?? 0) < need;

// Nearest enemy base `self` still owes hits, within `rangeSq`, or null. Nearest
// is measured across the wrap (correct pick); the base's absolute coords are
// returned so the caller can plan its own rank-gated course to them.
const nearestRaidableBase = (
  self: LightCycle,
  baseHp: Readonly<Record<string, number>>,
  need: number,
  rangeSq: number,
): { tx: number; ty: number } | null => {
  let tx = 0;
  let ty = 0;
  let bestD2 = rangeSq;
  let found = false;
  for (const base of TEAM_BASES) {
    if (!isRaidableBase(self, base, baseHp, need)) continue;
    const dx = wrapDelta(self.x, base.x, GRID_W); // self -> base
    const dy = wrapDelta(self.y, base.y, GRID_H);
    const d2 = dx * dx + dy * dy;
    if (d2 >= bestD2) continue;
    bestD2 = d2;
    tx = base.x;
    ty = base.y;
    found = true;
  }
  return found ? { tx, ty } : null;
};

const steerObjective = (
  self: LightCycle,
  level: number,
  baseHp: Readonly<Record<string, number>>,
): [number, number] => {
  const objGain = OBJECTIVE_GAIN[level - 1] ?? 0;
  const objR = OBJECTIVE_RADIUS[level - 1] ?? 0;
  if (!(objGain > 0 && objR > 0)) return [0, 0];
  // Raided every enemy base → make for the center pad to cash in the level-up.
  // Rank-gated course (goalDelta): L3+ cut across the wrap, L4+ via portals.
  if (hasRaidedAllEnemyBases(self, baseHp)) {
    const [cx, cy] = normalize(goalDelta(self, CENTER_PAD.x, CENTER_PAD.y), [
      self.dx,
      self.dy,
    ]);
    return [cx * objGain, cy * objGain];
  }
  const need = baseHitsRequired(level);
  const hit = nearestRaidableBase(self, baseHp, need, objR * objR);
  if (!hit) return [0, 0];
  const [ux, uy] = normalize(goalDelta(self, hit.tx, hit.ty), [
    self.dx,
    self.dy,
  ]);
  return [ux * objGain, uy * objGain];
};

const steerRally = (
  self: LightCycle,
  rally: RallyBeacon | null,
): [number, number] => {
  if (!rally || rally.team !== self.colorName) return [0, 0];
  const rx = wrapDelta(self.x, rally.x, GRID_W);
  const ry = wrapDelta(self.y, rally.y, GRID_H);
  const d2 = rx * rx + ry * ry;
  if (d2 > RALLY_RADIUS * RALLY_RADIUS || d2 < 1e-3) return [0, 0];
  const dist = Math.sqrt(d2);
  const [ux, uy] = normalize([rx, ry], [self.dx, self.dy]);
  const arrive = Math.min(1, dist / RALLY_ARRIVE_RADIUS);
  return [ux * RALLY_GAIN * arrive, uy * RALLY_GAIN * arrive];
};

/**
 * Command priority: survival refuel first, then player rally, then ordinary
 * base raid. This keeps rally responsive without making ships suicidal.
 */
const steerCommandOrObjective = (
  self: LightCycle,
  ships: readonly LightCycle[],
  level: number,
  baseHp: Readonly<Record<string, number>>,
  rally: RallyBeacon | null,
): [number, number] => {
  // Survival first: break for the nearest fuel source once the tank can no
  // longer safely cover the trip there (range-aware, not a fixed fraction).
  const source = nearestFuelSource(self, ships);
  if (source && mustRefuel(self, source)) return steerFuelReturn(self, source);
  const [rx, ry] = steerRally(self, rally);
  return rx !== 0 || ry !== 0 ? [rx, ry] : steerObjective(self, level, baseHp);
};

/**
 * Wander term: two out-of-phase oscillators per ship give an organic,
 * ever-turning meander — the restlessness that makes a flock swirl
 * (murmuration) instead of settling into a rigid line. Deterministic (keyed
 * on age + ship id).
 */
const steerWander = (
  self: LightCycle,
  age: number,
  level: number,
): [number, number] => {
  const wanderGain = WANDER_GAIN[level - 1] ?? 0;
  if (!(wanderGain > 0)) return [0, 0];
  const p = age * 0.05 + self.id * 2.399;
  return [Math.cos(p) * wanderGain, Math.sin(p * 0.83 + self.id) * wanderGain];
};

/**
 * Boids-style steering that grows with rank. Combines separation (push off
 * nearby ships + hazards ahead), alignment (match same-team heading), cohesion
 * (drift toward the squad's center), and a per-ship wander (murmuration swirl).
 * Returns an acceleration vector; all weights scale with the ship's level.
 */
export const flockSteer = (
  self: LightCycle,
  ships: readonly LightCycle[],
  rocks: readonly Asteroid[],
  pickups: readonly Pickup[],
  baseHp: Readonly<Record<string, number>>,
  rally: RallyBeacon | null,
  level: number,
  age: number,
): [number, number] => {
  let [fx, fy] = steerSeparation(self, ships, rocks, level);

  const [alignDx, alignDy, cohereDx, cohereDy] = steerAlignCohere(
    self,
    ships,
    level,
  );
  fx += alignDx;
  fy += alignDy;
  fx += cohereDx;
  fy += cohereDy;

  const [pursueDx, pursueDy] = steerPursuit(self, ships, level);
  fx += pursueDx;
  fy += pursueDy;

  const [pickDx, pickDy] = steerPickupSeek(self, pickups, level);
  fx += pickDx;
  fy += pickDy;

  const [healDx, healDy] = steerHealSeek(self, level);
  fx += healDx;
  fy += healDy;

  const [padDx, padDy] = steerCenterPadSeek(self, level);
  fx += padDx;
  fy += padDy;

  const [objDx, objDy] = steerCommandOrObjective(
    self,
    ships,
    level,
    baseHp,
    rally,
  );
  fx += objDx;
  fy += objDy;

  const [wanderDx, wanderDy] = steerWander(self, age, level);
  fx += wanderDx;
  fy += wanderDy;

  return [fx, fy];
};
