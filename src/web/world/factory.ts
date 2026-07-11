// Pure builders, tuning constants, and math helpers for the world sim. Every
// function here is referentially transparent: randomness is threaded through the
// PRNG seed, nothing reads a clock or mutates shared state.

import {
  angleTo,
  easeAngle,
  normalize,
  rotate,
  wrapDelta,
} from "../engine/physics";
import { nextInt, nextRange, pick, type Seed } from "../engine/rng";
import { ASTEROID_VARIANTS, durationOf, EXPLOSION_CLIPS } from "../sprites";
import {
  ARCHETYPES,
  type Archetype,
  type Asteroid,
  type Bullet,
  baseByName,
  GRID_H,
  GRID_W,
  HEAL_PADS,
  type LightCycle,
  type Missile,
  PICKUP_KINDS,
  type Pickup,
  type PickupKind,
  type Projectile,
  TEAM_BASES,
  TEAMS,
  type Team,
  teamByName,
} from "./types";

// --- Field + gameplay tuning ------------------------------------------------
export const MAX_SHIPS = 12;
// Generations of reinforcement before sudden death (~60s at 45 gen/s). After
// this, no respawns/reinforcements — teams get wiped until one is left standing.
export const MATCH_REINFORCE_GENS = 2700;
export const NUM_ASTEROIDS = 5;
export const NUM_PICKUPS = 3;
export const PICKUP_RADIUS = 9; // collect distance (ship center to bubble)
export const BOOST_DURATION = 320; // gens of speed boost
export const BOOST_MULT = 1.6; // cruise multiplier while boosted
export const OVERCHARGE_DURATION = 270; // gens of halved fire cooldown
export const OVERCHARGE_MULT = 0.5; // fire cooldown multiplier while overcharged
export const CLOAK_DURATION = 150; // gens of invulnerability
export const EMP_RADIUS = 42; // AoE reach of an EMP pickup
export const EMP_DAMAGE = 2; // damage each enemy in the EMP blast takes
export const FORCEFIELD_DURATION = 420; // gens the force-field aura lasts
export const FORCEFIELD_RADIUS = 24; // aura reach (push + melee)
export const FORCEFIELD_PUSH = 0.12; // knockback accel applied to enemies/gen
export const FORCEFIELD_DAMAGE = 1; // melee damage to an enemy caught in it
export const PORTAL_COOLDOWN = 40; // gens before a ship can re-enter a portal
export const PORTAL_PULL = 0.02; // event-horizon accel toward a nearby gate
export const PORTAL_HORIZON = 2.6; // pull reaches this × the gate radius
export const PAD_HEAL = 0.09; // HP/gen while sitting on a healing pad
export const HOME_RADIUS = 12; // over own base -> chance to promote
export const BASE_MAX_HP = 24; // base integrity; 0 = team eliminated
export const BASE_RADIUS = 11; // solid collision radius of a base
export const BASE_HEAL_RATE = 0.05; // base HP/gen while an ally sits on it
export const BASE_RAM_DAMAGE = 1; // base HP lost per enemy ram (behind i-frames)
export const BASE_LEVELUP_CHANCE = 0.005; // per-gen promotion odds while docked
export const SHRAPNEL_LIFE = 130; // gens a shrapnel fragment lives
export const SHRAPNEL_RADIUS = 5; // fragment hit radius vs ships
export const HIT_COOLDOWN = 20; // gens a ship is immune after trading a hit
export const SHIELD_BASE_REGEN = 0.012; // fraction of max shield healed/gen home
export const MINE_ARM = 25; // gens before a dropped mine goes live
export const MINE_LIFE = 900; // gens a mine persists
export const MINE_RADIUS = 10; // detonation trigger distance
export const MINE_DAMAGE = 2; // damage dealt on detonation
export const MINE_DROP_CHANCE = 0.012; // per-gen odds an armed L3+ ship drops one
export const SCORE_MERGE = 50; // two allies merge / level up
export const SCORE_KILL = 100; // a ship is destroyed in a dogfight
export const SCORE_PICKUP = 25; // a power-up bubble collected

// --- Weapon bolts -----------------------------------------------------------
export const BULLET_SPEED = 3.4; // cells/gen
export const BULLET_LIFE = 30; // gens; range ≈ SPEED * LIFE ≈ 100 cells
export const BULLET_RADIUS = 3.5; // hit radius vs a ship (plus its own radius)
export const BULLET_DAMAGE = 1;
export const FIRE_RANGE = 95; // only fire when an enemy is within this
// Fire cadence tightens with rank: aces spit bolts ~2.5× as fast as rookies.
const FIRE_COOLDOWN_BY_LEVEL = [90, 74, 60, 48, 38]; // gens between shots
export const fireCooldownForLevel = (level: number): number =>
  FIRE_COOLDOWN_BY_LEVEL[level - 1] ?? FIRE_COOLDOWN_BY_LEVEL[0];

// Longest explosion variant — bursts live at least this long so none clip early.
export const EXPLOSION_DURATION = Math.max(...EXPLOSION_CLIPS.map(durationOf));

// --- Per-level stat tables (indexed by level-1) -----------------------------
// Movement smarts unlock with rank: each rank dodges better, flocks tighter, and
// regulates speed/heading more precisely; L5 is a coordinated ace.
const AVOID_GAIN = [0, 0.035, 0.07, 0.09, 0.11]; // separation from ships + rocks
const AVOID_RADIUS = [0, 24, 34, 40, 46];
const ALIGN_GAIN = [0, 0.05, 0.09, 0.12, 0.15]; // match same-team heading
const COHERE_GAIN = [0, 0.005, 0.01, 0.014, 0.018]; // pull toward team center
const FLOCK_RADIUS = [0, 42, 58, 70, 82]; // wide, so alignment waves propagate
// Every rank meanders (murmuration lifeblood); higher ranks a touch livelier.
const WANDER_GAIN = [0.03, 0.032, 0.036, 0.04, 0.045];
// Pursuit: steer toward the nearest enemy in range. L1 doesn't hunt; higher
// ranks lock on harder and from farther out. Aces (L4/L5) hold at gun range
// (KITE_DIST > 0): they approach when beyond it, back off when inside it, so
// they orbit and pepper instead of ramming. Lower ranks (KITE_DIST 0) close in.
const ENGAGE_GAIN = [0, 0.03, 0.055, 0.08, 0.1];
const ENGAGE_RADIUS = [0, 60, 90, 120, 140];
const KITE_DIST = [0, 0, 0, 70, 78]; // 0 = ram; >0 = preferred standoff range
// Objective play: chase power-up bubbles, and when hurt peel off to a heal pad.
// L1 is a pure brawler (0); higher ranks sense farther, pull harder, and retreat
// to heal sooner — so battlefield IQ tracks rank.
const PICKUP_SEEK_GAIN = [0, 0.022, 0.038, 0.052, 0.064];
const PICKUP_SEEK_RADIUS = [0, 50, 78, 105, 130];
const HEAL_SEEK_GAIN = [0, 0.03, 0.05, 0.07, 0.09];
const HEAL_SEEK_RADIUS = [0, 60, 90, 120, 150];
const HEAL_HP_THRESHOLD = [0, 0.35, 0.45, 0.55, 0.62]; // HP frac below → retreat
// Base-raid objective: L2+ ships steer toward enemy bases they still need to hit
// (the leveling path). L1 rookies ignore it and just brawl.
const OBJECTIVE_GAIN = [0, 0.025, 0.04, 0.05, 0.055];
const OBJECTIVE_RADIUS = [0, 90, 120, 150, 170];

// How much a ship *wants* a bubble kind given its current deficit. Matching-need
// bubbles read as "closer" in the seek scan, so a hurt ship favors heals and a
// shield-down ship favors shields; a healthy ship just grabs whatever is nearest.
const wantHeal = (self: LightCycle): number =>
  self.hp < self.maxHp * 0.6 ? 2.5 : 1;
const wantShield = (self: LightCycle): number =>
  self.maxShield > 0 && self.shield < self.maxShield * 0.5 ? 2.0 : 1;
const wantRankUp = (self: LightCycle): number => (self.level < 5 ? 3.0 : 0.2); // aces don't need it
const wantCloak = (self: LightCycle): number =>
  self.hp < self.maxHp * 0.5 ? 1.8 : 1.0; // escape want rises when hurt

// Kinds whose want is a flat constant, independent of ship state.
const FIXED_PICKUP_WANT: Partial<Record<PickupKind, number>> = {
  3: 1.6, // overcharge — aggressive want
  4: 1.4, // EMP
  7: 1.7, // force field — aggressive want
};

const pickupWant = (self: LightCycle, kind: PickupKind): number => {
  switch (kind) {
    case 0:
      return wantHeal(self);
    case 1:
      return wantShield(self);
    case 5:
      return wantRankUp(self);
    case 6:
      return wantCloak(self);
  }
  return FIXED_PICKUP_WANT[kind] ?? 1.2; // speed — mildly nice to have
};
export const TURN_EASE_LVL = [0.11, 0.17, 0.24, 0.3, 0.35]; // heading tracking
export const SPEED_EASE_LVL = [0.05, 0.09, 0.14, 0.18, 0.22]; // cruise control
const REGEN_BY_LEVEL = [0.006, 0.018, 0.038, 0.06, 0.085]; // self-repair HP/gen
const SHIELD_BY_LEVEL = [1, 2, 3, 4, 5]; // secondary shield capacity
const SPEED_BY_LEVEL = [0.65, 0.95, 1.35, 1.7, 2.0];
const RADIUS_BY_LEVEL = [5.5, 8, 9.5, 11, 12.5]; // matches overlay sprite sizes
const MINES_BY_LEVEL = [0, 0, 2, 3, 4]; // only L3+ carry mines

// --- Fuel: ships burn fuel to thrust, refuel at their home base -------------
export const FUEL_BASE = 700; // L1 tank size before the archetype multiplier
export const FUEL_BURN = 1; // tank units spent per gen of thrust
export const FUEL_REFILL = 9; // units/gen refilled while docked at home base
export const FUEL_LOW_FRAC = 0.3; // below this fraction → peel off to refuel
export const FUEL_GROWTH = 0.25; // +25% tank capacity per level
export const FUEL_RETURN_GAIN = 0.09; // steering pull home when the tank runs low
export const FUEL_DRIFT_SPEED = 0.12; // dead-engine coast speed (drifts like an orb)
// Carrier fuel-sharing: a carrier tops up nearby lower-fuel allies mid-flight.
export const FUEL_SHARE_RADIUS = 30; // reach to a thirsty ally
export const FUEL_SHARE_RATE = 4; // units/gen transferred to each ally
export const FUEL_SHARE_RESERVE = 0.25; // carrier keeps this fraction for itself

// --- Class archetypes: per-class stat multipliers + weapon tree -------------
export const ARCHETYPE_MODS: Record<
  Archetype,
  {
    speed: number;
    hp: number;
    fire: number;
    fuel: number; // tank-capacity multiplier
    mines: boolean;
    missiles: boolean;
    fuelShare: boolean; // carrier: refuels nearby allies
  }
> = {
  scout: {
    speed: 1.3,
    hp: 0.75,
    fire: 0.9,
    fuel: 0.8,
    mines: false,
    missiles: false,
    fuelShare: false,
  },
  fighter: {
    speed: 1.0,
    hp: 1.0,
    fire: 0.72,
    fuel: 1.0,
    mines: false,
    missiles: false,
    fuelShare: false,
  },
  heavy: {
    speed: 0.78,
    hp: 1.5,
    fire: 1.15,
    fuel: 1.8,
    mines: true,
    missiles: false,
    fuelShare: true, // the carrier: big tank, shares with allies
  },
  interceptor: {
    speed: 1.12,
    hp: 0.9,
    fire: 0.95,
    fuel: 1.0,
    mines: false,
    missiles: true,
    fuelShare: false,
  },
};

export const maxHpForLevel = (level: number): number => 1 + level; // L1=2 … L5=6
export const speedForLevel = (level: number): number =>
  SPEED_BY_LEVEL[level - 1] ?? SPEED_BY_LEVEL[0];
export const shipRadius = (level: number): number =>
  RADIUS_BY_LEVEL[level - 1] ?? RADIUS_BY_LEVEL[0];
export const regenForLevel = (level: number): number =>
  REGEN_BY_LEVEL[level - 1] ?? REGEN_BY_LEVEL[0];
export const shieldForLevel = (level: number): number =>
  SHIELD_BY_LEVEL[level - 1] ?? SHIELD_BY_LEVEL[0];
export const minesForLevel = (level: number): number =>
  MINES_BY_LEVEL[level - 1] ?? 0;

// Archetype-aware stats: base per-level value × the class modifier.
export const cruiseFor = (a: Archetype, level: number): number =>
  speedForLevel(level) * ARCHETYPE_MODS[a].speed;
export const maxHpFor = (a: Archetype, level: number): number =>
  Math.max(1, Math.round(maxHpForLevel(level) * ARCHETYPE_MODS[a].hp));
export const fireCooldownFor = (a: Archetype, level: number): number =>
  fireCooldownForLevel(level) * ARCHETYPE_MODS[a].fire;
export const minesFor = (a: Archetype, level: number): number =>
  ARCHETYPE_MODS[a].mines ? minesForLevel(level) : 0;
export const carriesMissiles = (a: Archetype): boolean =>
  ARCHETYPE_MODS[a].missiles;
export const isCarrier = (a: Archetype): boolean => ARCHETYPE_MODS[a].fuelShare;
export const maxFuelFor = (a: Archetype, level: number): number =>
  Math.round(
    FUEL_BASE * ARCHETYPE_MODS[a].fuel * (1 + (level - 1) * FUEL_GROWTH),
  );
/** Hits needed on EACH alive enemy base to earn the next level (grows w/ rank). */
export const baseHitsRequired = (level: number): number => level;
const asteroidHp = (size: number): number => Math.max(2, Math.round(size / 3));

// --- Math helpers -----------------------------------------------------------
export const wrap = (v: number, limit: number): number =>
  ((v % limit) + limit) % limit;

/** Minimum toroidal distance across a wrapped axis. */
export const toroidalDist = (a: number, b: number, limit: number): number => {
  const diff = Math.abs(a - b);
  return diff > limit / 2 ? limit - diff : diff;
};

/** Apply `amt` damage: the shield soaks it first, the rest spills to hull HP. */
export const applyHit = (
  s: { shield: number; hp: number },
  amt: number,
): void => {
  const soaked = Math.min(s.shield, amt);
  s.shield -= soaked;
  s.hp -= amt - soaked;
};

/** A fresh scoreboard with every team at zero. */
export const zeroScores = (): Record<string, number> =>
  Object.fromEntries(TEAMS.map((t) => [t.name, 0]));

/** Every team's base at full integrity. */
export const fullBaseHp = (): Record<string, number> =>
  Object.fromEntries(TEAMS.map((t) => [t.name, BASE_MAX_HP]));

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

// --- Builders ---------------------------------------------------------------

/**
 * Fold `count` seed-threaded builds into a list, returning [items, nextSeed].
 * Encapsulates the "draw N deterministic entities" pattern so call sites stay
 * declarative. O(count) — same as the hand-rolled loop it replaces.
 */
export const rollMany = <T>(
  count: number,
  seed: Seed,
  roll: (seed: Seed, index: number) => [T, Seed],
): [T[], Seed] => {
  const items: T[] = [];
  let s = seed;
  for (let i = 0; i < count; i++) {
    const [item, next] = roll(s, i);
    items.push(item);
    s = next;
  }
  return [items, s];
};

/** Resolve a ship's team + archetype from the seed unless the caller forces either. */
const resolveTeamAndArchetype = (
  seed: Seed,
  forceColor?: string,
  forceArchetype?: Archetype,
): [Team, Archetype, Seed] => {
  let s = seed;
  let team = forceColor ? teamByName.get(forceColor) : undefined;
  if (!team) {
    const [picked, s1] = pick(s, TEAMS);
    team = picked;
    s = s1;
  }
  let archetype = forceArchetype;
  if (!archetype) {
    const [picked, s1] = pick(s, ARCHETYPES);
    archetype = picked;
    s = s1;
  }
  return [team, archetype, s];
};

/** Construct a fresh ship's stat block once team/archetype/heading are known. */
const buildShip = (
  id: number,
  x: number,
  y: number,
  level: number,
  archetype: Archetype,
  team: Team,
  dir: readonly [number, number],
): LightCycle => {
  const maxHp = maxHpFor(archetype, level);
  const maxShield = shieldForLevel(level);
  const [hx, hy] = normalize([dir[0], dir[1]]); // DIRS diagonals aren't unit
  const cruise = cruiseFor(archetype, level);
  const mines = minesFor(archetype, level);
  return {
    id,
    x,
    y,
    dx: hx,
    dy: hy,
    vx: hx * cruise,
    vy: hy * cruise,
    color: team.rgb,
    colorName: team.name,
    level,
    archetype,
    angle: angleTo([hx, hy]),
    hp: maxHp,
    maxHp,
    shield: maxShield,
    maxShield,
    mines,
    maxMines: mines,
    beamActive: false,
    beamX: 0,
    beamY: 0,
    beamTime: 0,
    hitCooldown: 0,
    hitFlash: 0,
    overchargeTime: 0,
    invulnTime: 0,
    forceFieldTime: 0,
    boostTime: 0,
    portalCooldown: 0,
    fireCooldown: fireCooldownForLevel(level),
    fuel: maxFuelFor(archetype, level),
    maxFuel: maxFuelFor(archetype, level),
    baseHits: {},
  };
};

/** Build a ship with a color/direction/class drawn from the seed; returns seed. */
export const rollShip = (
  seed: Seed,
  id: number,
  x: number,
  y: number,
  level: number,
  forceColor?: string,
  forceArchetype?: Archetype,
): [LightCycle, Seed] => {
  const [team, archetype, s1] = resolveTeamAndArchetype(
    seed,
    forceColor,
    forceArchetype,
  );
  const [dir, s2] = pick(s1, DIRS);
  const ship = buildShip(id, x, y, level, archetype, team, dir);
  return [ship, s2];
};

/** Gens the shield flare lasts after a hit (drives the impact flash/ripple). */
export const SHIELD_FLASH = 12;

/** Apply damage to a ship AND light its shield flare. Use at every hit site. */
export const hurtShip = (
  s: { shield: number; hp: number; hitFlash: number },
  amt: number,
): void => {
  applyHit(s, amt);
  s.hitFlash = SHIELD_FLASH;
};

/**
 * Nearest enemy-team ship to `self`, or null if none. Toroidal distance;
 * `skip` excludes ships already removed this tick. O(ships) — ≤12 ships.
 */
export const nearestEnemy = (
  self: LightCycle,
  ships: readonly LightCycle[],
  skip: ReadonlySet<number>,
): { ship: LightCycle; dist: number } | null => {
  let best: LightCycle | null = null;
  let bestD2 = Infinity;
  for (const o of ships) {
    if (o.id === self.id || o.colorName === self.colorName || skip.has(o.id))
      continue;
    const dx = wrapDelta(o.x, self.x, GRID_W);
    const dy = wrapDelta(o.y, self.y, GRID_H);
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = o;
    }
  }
  return best ? { ship: best, dist: Math.sqrt(bestD2) } : null;
};

// --- Seeking missiles (L4+ heavy volley) ------------------------------------
export const MISSILE_SPEED = 2.4; // cells/gen (slower than a bolt; it homes)
export const MISSILE_TURN = 0.12; // heading ease toward the target per gen
export const MISSILE_LIFE = 90; // gens before it fizzles
export const MISSILE_RADIUS = 4; // hit radius vs a ship (plus its own radius)
export const MISSILE_DAMAGE = 2;
export const MISSILE_RANGE = 120; // lock-on distance
export const MISSILE_MIN_LEVEL = 4; // only aces carry missiles
export const MISSILE_FIRE_CHANCE = 0.02; // per-gen odds while a target is locked

/** A missile fired from `s`, locked onto `target`. */
export const spawnMissile = (
  id: number,
  s: LightCycle,
  target: LightCycle,
): Missile => {
  const [ax, ay] = normalize(
    [wrapDelta(s.x, target.x, GRID_W), wrapDelta(s.y, target.y, GRID_H)],
    [s.dx, s.dy],
  );
  const nose = shipRadius(s.level) + 1;
  return {
    id,
    x: wrap(s.x + ax * nose, GRID_W),
    y: wrap(s.y + ay * nose, GRID_H),
    vx: ax * MISSILE_SPEED,
    vy: ay * MISSILE_SPEED,
    team: s.colorName,
    rgb: s.color,
    angle: angleTo([ax, ay]),
    targetId: target.id,
    damage: MISSILE_DAMAGE,
    life: MISSILE_LIFE,
    owner: s.id,
  };
};

/**
 * Advance one missile `steps` gens: if its target still lives, ease the heading
 * toward it (turn-rate limited) then move; otherwise fly straight. Pure.
 */
export const advanceMissile = (
  m: Missile,
  target: LightCycle | undefined,
  steps: number,
): Missile => {
  let angle = m.angle;
  if (target) {
    const desired = angleTo(
      normalize(
        [wrapDelta(m.x, target.x, GRID_W), wrapDelta(m.y, target.y, GRID_H)],
        [Math.sin(m.angle), Math.cos(m.angle)],
      ),
    );
    angle = easeAngle(m.angle, desired, Math.min(1, MISSILE_TURN * steps));
  }
  const ax = Math.sin(angle);
  const ay = Math.cos(angle);
  return {
    ...m,
    angle,
    vx: ax * MISSILE_SPEED,
    vy: ay * MISSILE_SPEED,
    x: wrap(m.x + ax * MISSILE_SPEED * steps, GRID_W),
    y: wrap(m.y + ay * MISSILE_SPEED * steps, GRID_H),
    life: m.life - steps,
  };
};

// --- Squad coordination (rank-gated) ----------------------------------------
export const COORDINATE_MIN_LEVEL = 3; // L3+ focus-fire; lower ranks fight solo

/** Is `o` a valid focus-fire candidate for `self` (enemy, not already excluded)? */
const isFocusCandidate = (
  self: LightCycle,
  o: LightCycle,
  skip: ReadonlySet<number>,
): boolean =>
  o.id !== self.id && o.colorName !== self.colorName && !skip.has(o.id);

/** Does candidate `o` beat the current best (weaker, or tied-and-closer)? */
const isBetterFocusTarget = (
  o: LightCycle,
  d2: number,
  bestHp: number,
  bestD2: number,
): boolean => o.hp < bestHp || (o.hp === bestHp && d2 < bestD2);

/**
 * Focus-fire target: the *weakest* enemy within `range` (tiebreak nearest), or
 * null. Because coordinating allies all apply this same policy, they converge
 * fire on one wounded target and finish it — emergent teamwork, no shared state.
 */
export const focusEnemy = (
  self: LightCycle,
  ships: readonly LightCycle[],
  range: number,
  skip: ReadonlySet<number>,
): { ship: LightCycle; dist: number } | null => {
  const r2 = range * range;
  let best: LightCycle | null = null;
  let bestHp = Number.POSITIVE_INFINITY;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (const o of ships) {
    if (!isFocusCandidate(self, o, skip)) continue;
    const dx = wrapDelta(self.x, o.x, GRID_W);
    const dy = wrapDelta(self.y, o.y, GRID_H);
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    if (isBetterFocusTarget(o, d2, bestHp, bestD2)) {
      best = o;
      bestHp = o.hp;
      bestD2 = d2;
    }
  }
  return best ? { ship: best, dist: Math.sqrt(bestD2) } : null;
};

/** Target for `self` at `range`: focus-fire if it's a coordinating rank, else nearest. */
export const acquireTarget = (
  self: LightCycle,
  ships: readonly LightCycle[],
  range: number,
  skip: ReadonlySet<number>,
): { ship: LightCycle; dist: number } | null =>
  self.level >= COORDINATE_MIN_LEVEL
    ? focusEnemy(self, ships, range, skip)
    : nearestEnemy(self, ships, skip);

/** A weapon bolt fired from `s` toward point (tx, ty) — an enemy ship or base. */
export const spawnBullet = (
  id: number,
  s: LightCycle,
  tx: number,
  ty: number,
): Bullet => {
  const [ax, ay] = normalize(
    [wrapDelta(tx, s.x, GRID_W), wrapDelta(ty, s.y, GRID_H)],
    [s.dx, s.dy],
  );
  const nose = shipRadius(s.level) + 1;
  return {
    id,
    x: wrap(s.x + ax * nose, GRID_W),
    y: wrap(s.y + ay * nose, GRID_H),
    vx: ax * BULLET_SPEED,
    vy: ay * BULLET_SPEED,
    team: s.colorName,
    rgb: s.color,
    angle: angleTo([ax, ay]),
    damage: BULLET_DAMAGE,
    life: BULLET_LIFE,
    owner: s.id,
  };
};

/** Build a drifting power-up bubble with a random kind + trajectory. */
export const rollPickup = (seed: Seed, id: number): [Pickup, Seed] => {
  const [x, s1] = nextRange(seed, 30, GRID_W - 30);
  const [y, s2] = nextRange(s1, 30, GRID_H - 30);
  const [ang, s3] = nextRange(s2, 0, Math.PI * 2);
  const [spd, s4] = nextRange(s3, 0.05, 0.18);
  const [k, s5] = nextInt(s4, PICKUP_KINDS);
  const [bob, s6] = nextRange(s5, 0, Math.PI * 2);
  const pickup: Pickup = {
    id,
    x,
    y,
    vx: Math.cos(ang) * spd,
    vy: Math.sin(ang) * spd,
    kind: k as PickupKind,
    bob,
  };
  return [pickup, s6];
};

/** Random grid position for a fresh spawn; returns next seed. */
export const rollPosition = (seed: Seed): [number, number, Seed] => {
  const [rx, s1] = nextRange(seed, 60, 420);
  const [ry, s2] = nextRange(s1, 50, 220);
  return [Math.floor(rx), Math.floor(ry), s2];
};

/**
 * Build a drifting asteroid. It always enters from a field edge heading inward
 * (never pops into existence mid-world) with a little angular spread; returns the
 * next seed. Heading uses the sim's atan2(x, y) convention → (sin, cos).
 */
export const rollAsteroid = (seed: Seed, id: number): [Asteroid, Seed] => {
  const [edge, s1] = nextInt(seed, 4); // 0 top, 1 bottom, 2 left, 3 right
  const [along, s2] = nextRange(s1, 0, 1); // fraction along the edge
  const [spd, s3] = nextRange(s2, 0.14, 0.4);
  const [spread, s4] = nextRange(s3, -0.5, 0.5); // inward angle jitter (rad)
  const [spinRate, s5] = nextRange(s4, -0.04, 0.04);
  const [curl, s6] = nextRange(s5, -0.012, 0.012);
  const [size, s7] = nextRange(s6, 5, 13);
  const [variant, s8] = nextInt(s7, ASTEROID_VARIANTS);
  const hp = asteroidHp(size);
  // Position on the chosen edge + the inward base heading (0 = +y / down).
  let x = 0;
  let y = 0;
  let baseAng = 0;
  if (edge === 0) {
    x = along * GRID_W;
    baseAng = 0; // top → down
  } else if (edge === 1) {
    x = along * GRID_W;
    y = GRID_H;
    baseAng = Math.PI; // bottom → up
  } else if (edge === 2) {
    y = along * GRID_H;
    baseAng = Math.PI / 2; // left → right
  } else {
    x = GRID_W;
    y = along * GRID_H;
    baseAng = -Math.PI / 2; // right → left
  }
  const ang = baseAng + spread;
  const asteroid: Asteroid = {
    id,
    x,
    y,
    vx: Math.sin(ang) * spd,
    vy: Math.cos(ang) * spd,
    spin: ang,
    spinRate,
    curl,
    size,
    variant,
    portalCooldown: 0,
    hp,
    maxHp: hp,
  };
  return [asteroid, s8];
};

/** Burst of shrapnel fragments flung radially from a shattered asteroid. */
export const spawnShrapnel = (
  seed: Seed,
  id0: number,
  rock: Asteroid,
): [Projectile[], Seed, number] => {
  const [countF, s1] = nextRange(seed, 3, 3 + rock.size / 2);
  const count = Math.round(countF);
  let s = s1;
  let id = id0;
  const out: Projectile[] = [];
  for (let i = 0; i < count; i++) {
    const [jitter, sa] = nextRange(s, -0.4, 0.4);
    const [spd, sb] = nextRange(sa, 0.6, 1.3);
    const [spinRate, sc] = nextRange(sb, -0.25, 0.25);
    const [variant, sd] = nextInt(sc, ASTEROID_VARIANTS);
    s = sd;
    const ang = (Math.PI * 2 * i) / count + jitter;
    out.push({
      id,
      x: rock.x,
      y: rock.y,
      vx: rock.vx + Math.cos(ang) * spd,
      vy: rock.vy + Math.sin(ang) * spd,
      spin: ang,
      spinRate,
      life: SHRAPNEL_LIFE,
      variant,
    });
    id += 1;
  }
  return [out, s, id];
};

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
  let best = Infinity;
  let found = false;
  const pickR2 = pickR * pickR;
  for (const p of pickups) {
    const dx = wrapDelta(self.x, p.x, GRID_W); // self -> bubble
    const dy = wrapDelta(self.y, p.y, GRID_H);
    const d2 = dx * dx + dy * dy;
    if (d2 > pickR2) continue;
    const score = d2 / pickupWant(self, p.kind); // wanted kinds feel nearer
    if (score < best) {
      best = score;
      bx = dx;
      by = dy;
      found = true;
    }
  }
  if (!found) return [0, 0];
  const [ux, uy] = normalize([bx, by], [self.dx, self.dy]);
  return [ux * pickGain, uy * pickGain];
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

/** Fuel-return term: low tank → break off and head home to refuel (survival trumps the raid). */
const steerFuelReturn = (self: LightCycle): [number, number] => {
  const home = baseByName.get(self.colorName);
  if (!home) return [0, 0];
  const [ux, uy] = normalize(
    [wrapDelta(self.x, home.x, GRID_W), wrapDelta(self.y, home.y, GRID_H)],
    [self.dx, self.dy],
  );
  const urgency = 1 - self.fuel / (self.maxFuel * FUEL_LOW_FRAC);
  return [
    ux * FUEL_RETURN_GAIN * (0.6 + urgency),
    uy * FUEL_RETURN_GAIN * (0.6 + urgency),
  ];
};

/** Base-raid objective term: L2+ ships push toward an enemy base they still owe hits. */
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

/** Nearest enemy base `self` still owes hits, within `rangeSq`, or null. */
const nearestRaidableBase = (
  self: LightCycle,
  baseHp: Readonly<Record<string, number>>,
  need: number,
  rangeSq: number,
): { bx: number; by: number } | null => {
  let bx = 0;
  let by = 0;
  let bestD2 = rangeSq;
  let found = false;
  for (const base of TEAM_BASES) {
    if (!isRaidableBase(self, base, baseHp, need)) continue;
    const dx = wrapDelta(self.x, base.x, GRID_W); // self -> base
    const dy = wrapDelta(self.y, base.y, GRID_H);
    const d2 = dx * dx + dy * dy;
    if (d2 >= bestD2) continue;
    bestD2 = d2;
    bx = dx;
    by = dy;
    found = true;
  }
  return found ? { bx, by } : null;
};

const steerObjective = (
  self: LightCycle,
  level: number,
  baseHp: Readonly<Record<string, number>>,
): [number, number] => {
  const objGain = OBJECTIVE_GAIN[level - 1] ?? 0;
  const objR = OBJECTIVE_RADIUS[level - 1] ?? 0;
  if (!(objGain > 0 && objR > 0)) return [0, 0];
  const need = baseHitsRequired(level);
  const hit = nearestRaidableBase(self, baseHp, need, objR * objR);
  if (!hit) return [0, 0];
  const [ux, uy] = normalize([hit.bx, hit.by], [self.dx, self.dy]);
  return [ux * objGain, uy * objGain];
};

/** Fuel logistics vs. base raid: refuel when low, otherwise chase the raid objective. */
const steerFuelOrObjective = (
  self: LightCycle,
  level: number,
  baseHp: Readonly<Record<string, number>>,
): [number, number] =>
  self.fuel < self.maxFuel * FUEL_LOW_FRAC
    ? steerFuelReturn(self)
    : steerObjective(self, level, baseHp);

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

  const [objDx, objDy] = steerFuelOrObjective(self, level, baseHp);
  fx += objDx;
  fy += objDy;

  const [wanderDx, wanderDy] = steerWander(self, age, level);
  fx += wanderDx;
  fy += wanderDy;

  return [fx, fy];
};

/** Drift + swirl one asteroid forward by `steps` gens (pure, wraps toroidally). */
export const advanceAsteroid = (a: Asteroid, steps: number): Asteroid => {
  const [vx, vy] = rotate([a.vx, a.vy], a.curl * steps);
  return {
    ...a,
    vx,
    vy,
    x: wrap(a.x + vx * steps, GRID_W),
    y: wrap(a.y + vy * steps, GRID_H),
    spin: a.spin + a.spinRate * steps,
    portalCooldown: Math.max(0, a.portalCooldown - steps),
  };
};
