// Pure spawn/advance builders for the world sim: rolling ships, asteroids and
// pickups, spawning and steering projectiles. Every function here is
// referentially transparent: randomness is threaded through the PRNG seed,
// nothing reads a clock or mutates shared state. Tuning constants live in
// tuning.ts, geometry helpers in math.ts — import those directly.

import {
  angleTo,
  easeAngle,
  normalize,
  rotate,
  wrapDelta,
} from "~/engine/physics";
import { nextInt, nextRange, pick, rollMany, type Seed } from "~/engine/rng";
import { applyHit, distSq, wrap } from "./math";
import {
  ASTEROID_VARIANTS,
  asteroidHp,
  BULLET_RICOCHETS,
  BULLET_SPEED,
  bulletDamageFor,
  bulletLifeFor,
  COORDINATE_MIN_LEVEL,
  cruiseFor,
  DRONE_BOLT_LIFE,
  DRONE_DAMAGE,
  EMP_DAMAGE,
  EMP_RADIUS,
  fireCooldownForLevel,
  MISSILE_DAMAGE,
  MISSILE_LIFE,
  MISSILE_SPEED,
  MISSILE_TURN,
  MUSTER_DRONE_RANGE_MULT,
  maxFuelFor,
  maxHpFor,
  minesFor,
  SHIELD_FLASH,
  SHRAPNEL_LIFE,
  shieldForLevel,
  shipRadius,
  targetPriority,
} from "./tuning";
import {
  ARCHETYPES,
  ARENA,
  type Archetype,
  type Asteroid,
  type Bullet,
  boltKindFor,
  type Drone,
  type LightCycle,
  type Missile,
  PICKUP_KINDS,
  type Pickup,
  type PickupKind,
  type Projectile,
  TEAMS,
  type Team,
  teamByName,
} from "./types";

// --- Builders ---------------------------------------------------------------

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

export { rollMany };

/** Resolve a ship's team + archetype from the seed unless the caller forces either. */
const resolveTeamAndArchetype = (
  seed: Seed,
  forceColor?: string,
  forceArchetype?: Archetype,
  teams: readonly Team[] = TEAMS,
): [Team, Archetype, Seed] => {
  let s = seed;
  let team = forceColor ? teamByName.get(forceColor) : undefined;
  if (!team) {
    const [picked, s1] = pick(s, teams);
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
    burstCount: 0,
    fuel: maxFuelFor(archetype, level),
    maxFuel: maxFuelFor(archetype, level),
    baseHits: {},
    xp: 0,
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
  teams: readonly Team[] = TEAMS,
): [LightCycle, Seed] => {
  const [team, archetype, s1] = resolveTeamAndArchetype(
    seed,
    forceColor,
    forceArchetype,
    teams,
  );
  const [dir, s2] = pick(s1, DIRS);
  const ship = buildShip(id, x, y, level, archetype, team, dir);
  return [ship, s2];
};

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
export function nearestEnemy(
  self: LightCycle,
  ships: readonly LightCycle[],
  skip: ReadonlySet<number>,
): { ship: LightCycle; dist: number } | null {
  let best: LightCycle | null = null;
  let bestD2 = Infinity;
  for (const o of ships) {
    if (o.id === self.id || o.colorName === self.colorName || skip.has(o.id))
      continue;
    const d2 = distSq(o.x, o.y, self.x, self.y);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = o;
    }
  }
  return best ? { ship: best, dist: Math.sqrt(bestD2) } : null;
}

// --- Seeking missiles (L4+ heavy volley) ------------------------------------

/** A missile fired from `s`, locked onto `target`. */
export function spawnMissile(
  id: number,
  s: LightCycle,
  target: LightCycle,
): Missile {
  const [ax, ay] = normalize(
    [wrapDelta(s.x, target.x, ARENA.w), wrapDelta(s.y, target.y, ARENA.h)],
    [s.dx, s.dy],
  );
  const nose = shipRadius(s.level) + 1;
  return {
    id,
    x: wrap(s.x + ax * nose, ARENA.w),
    y: wrap(s.y + ay * nose, ARENA.h),
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
}

/**
 * An EMP missile fired from `s`, locked onto `target`: homes like a normal
 * missile but detonates as an area blast (EMP_RADIUS) on contact rather than
 * hitting one ship. Reuses the standard missile flight/steering.
 */
export const spawnEmpMissile = (
  id: number,
  s: LightCycle,
  target: LightCycle,
): Missile => ({
  ...spawnMissile(id, s, target),
  damage: EMP_DAMAGE,
  blast: EMP_RADIUS,
});

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
        [wrapDelta(m.x, target.x, ARENA.w), wrapDelta(m.y, target.y, ARENA.h)],
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
    x: wrap(m.x + ax * MISSILE_SPEED * steps, ARENA.w),
    y: wrap(m.y + ay * MISSILE_SPEED * steps, ARENA.h),
    life: m.life - steps,
  };
};

// --- Squad coordination (rank-gated; COORDINATE_MIN_LEVEL lives in tuning) ---

/** Is `o` a valid focus-fire candidate for `self` (enemy, not already excluded)? */
const isFocusCandidate = (
  self: LightCycle,
  o: LightCycle,
  skip: ReadonlySet<number>,
): boolean =>
  o.id !== self.id && o.colorName !== self.colorName && !skip.has(o.id);

/** Does candidate `o` beat the current best (higher priority, or tied-and-closer)? */
const isBetterFocusTarget = (
  p: number,
  d2: number,
  bestP: number,
  bestD2: number,
): boolean => p > bestP || (p === bestP && d2 < bestD2);

/**
 * Focus-fire target: the highest-`targetPriority` enemy within `range` — the
 * weakest hull, biased toward high-level veterans (tiebreak nearest) — or null.
 * Because coordinating allies all apply this same policy, they converge fire on
 * one target and finish it, and a snowballing leader draws the squad's guns
 * rather than farming untouched — emergent teamwork, no shared state.
 */
export const focusEnemy = (
  self: LightCycle,
  ships: readonly LightCycle[],
  range: number,
  skip: ReadonlySet<number>,
): { ship: LightCycle; dist: number } | null => {
  const r2 = range * range;
  let best: LightCycle | null = null;
  let bestP = Number.NEGATIVE_INFINITY;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (const o of ships) {
    if (!isFocusCandidate(self, o, skip)) continue;
    const d2 = distSq(self.x, self.y, o.x, o.y);
    if (d2 > r2) continue;
    const p = targetPriority(o);
    if (isBetterFocusTarget(p, d2, bestP, bestD2)) {
      best = o;
      bestP = p;
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

/**
 * A weapon bolt fired from `s` toward point (tx, ty) — an enemy ship or base.
 * `lateral` shifts the muzzle sideways (perpendicular to the aim) for wing-
 * mounted parallel barrels: the bolts fly abreast on the same heading. Range
 * (bolt lifetime) scales with the shooter's rank via `bulletLifeFor`.
 */
export function spawnBullet(
  id: number,
  s: LightCycle,
  tx: number,
  ty: number,
  lateral = 0,
): Bullet {
  // Aim FROM the ship TO the target: wrapDelta(self, target) = target - self
  // (self first, matching every other "toward target" caller). Swapping these
  // fires the bolt out the ship's tail.
  const [ax, ay] = normalize(
    [wrapDelta(s.x, tx, ARENA.w), wrapDelta(s.y, ty, ARENA.h)],
    [s.dx, s.dy],
  );
  const nose = shipRadius(s.level) + 1;
  const px = -ay; // unit perpendicular to the aim heading
  const py = ax;
  return {
    id,
    x: wrap(s.x + ax * nose + px * lateral, ARENA.w),
    y: wrap(s.y + ay * nose + py * lateral, ARENA.h),
    vx: ax * BULLET_SPEED,
    vy: ay * BULLET_SPEED,
    team: s.colorName,
    rgb: s.color,
    angle: angleTo([ax, ay]),
    damage: bulletDamageFor(s.level),
    // Muster drone ships fire deliberately short — escorts, not extra heroes.
    life: Math.round(
      bulletLifeFor(s.level, s.archetype) *
        (s.droneShip ? MUSTER_DRONE_RANGE_MULT : 1),
    ),
    owner: s.id,
    bounces: BULLET_RICOCHETS,
    kind: boltKindFor(s.archetype),
  };
}

/** A bolt fired by an escort drone at a target point; credited to the owner. */
export function spawnDroneBolt(
  id: number,
  d: Pick<Drone, "x" | "y" | "team" | "rgb" | "ownerId">,
  tx: number,
  ty: number,
): Bullet {
  const [ax, ay] = normalize(
    [wrapDelta(d.x, tx, ARENA.w), wrapDelta(d.y, ty, ARENA.h)],
    [1, 0],
  );
  return {
    id,
    x: d.x,
    y: d.y,
    vx: ax * BULLET_SPEED,
    vy: ay * BULLET_SPEED,
    team: d.team,
    rgb: d.rgb,
    angle: angleTo([ax, ay]),
    damage: DRONE_DAMAGE,
    life: DRONE_BOLT_LIFE,
    owner: d.ownerId,
    bounces: 0,
    kind: 0,
  };
}

/** Build a drifting power-up bubble with a random kind + trajectory. */
export function rollPickup(
  seed: Seed,
  id: number,
  kinds: number = PICKUP_KINDS,
): [Pickup, Seed] {
  const [x, s1] = nextRange(seed, 30, ARENA.w - 30);
  const [y, s2] = nextRange(s1, 30, ARENA.h - 30);
  const [ang, s3] = nextRange(s2, 0, Math.PI * 2);
  const [spd, s4] = nextRange(s3, 0.05, 0.18);
  const [k, s5] = nextInt(s4, kinds);
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
}

/**
 * Build a drifting asteroid. It always enters from a field edge heading inward
 * (never pops into existence mid-world) with a little angular spread; returns the
 * next seed. Heading uses the sim's atan2(x, y) convention → (sin, cos).
 */
export function rollAsteroid(seed: Seed, id: number): [Asteroid, Seed] {
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
    x = along * ARENA.w;
    baseAng = 0; // top → down
  } else if (edge === 1) {
    x = along * ARENA.w;
    y = ARENA.h;
    baseAng = Math.PI; // bottom → up
  } else if (edge === 2) {
    y = along * ARENA.h;
    baseAng = Math.PI / 2; // left → right
  } else {
    x = ARENA.w;
    y = along * ARENA.h;
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
}

/** Burst of shrapnel fragments flung radially from a shattered asteroid. */
export function spawnShrapnel(
  seed: Seed,
  id0: number,
  rock: Asteroid,
): [Projectile[], Seed, number] {
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
}

/** Drift + swirl one asteroid forward by `steps` gens (pure, wraps toroidally). */
export function advanceAsteroid(a: Asteroid, steps: number): Asteroid {
  const [vx, vy] = rotate([a.vx, a.vy], a.curl * steps);
  return {
    ...a,
    vx,
    vy,
    x: wrap(a.x + vx * steps, ARENA.w),
    y: wrap(a.y + vy * steps, ARENA.h),
    spin: a.spin + a.spinRate * steps,
    portalCooldown: Math.max(0, a.portalCooldown - steps),
  };
}
