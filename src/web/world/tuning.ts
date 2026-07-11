import { durationOf, EXPLOSION_CLIPS } from "../sprites";
import {
  type Archetype,
  type LightCycle,
  MAX_TEAMS,
  type MatchConfig,
  type PickupKind,
  TEAMS,
  type Team,
} from "./types";

// --- Field + gameplay tuning ------------------------------------------------
export const MAX_SHIPS = 12;
// Generations of reinforcement before sudden death (~60s at 45 gen/s). After
// this, no respawns/reinforcements — teams get wiped until one is left standing.
export const MATCH_REINFORCE_GENS = 2700;

// The match setup a fresh world uses when the caller doesn't supply one —
// reproduces the pre-config behavior (all four teams, six ships, ~60s window).
export const DEFAULT_CONFIG: MatchConfig = {
  teams: MAX_TEAMS,
  initialShips: 6,
  reinforceRate: 3,
  tempo: 45,
  reinforceGens: MATCH_REINFORCE_GENS,
  format: "standard",
};

/** The teams actually in play this match — the first `config.teams` of TEAMS. */
export const activeTeams = (config: MatchConfig): readonly Team[] =>
  TEAMS.slice(0, config.teams);
export const NUM_ASTEROIDS = 5;
export const NUM_PICKUPS = 3;
export const PICKUP_RADIUS = 9; // collect distance (ship center to bubble)
export const BOOST_DURATION = 320; // gens of speed boost
export const BOOST_MULT = 1.6; // cruise multiplier while boosted
export const OVERCHARGE_DURATION = 270; // gens of halved fire cooldown
export const OVERCHARGE_MULT = 0.5; // fire cooldown multiplier while overcharged
export const CLOAK_DURATION = 150; // gens of invulnerability
export const EMP_RADIUS = 42; // AoE reach of an EMP blast (the detonation radius)
export const EMP_DAMAGE = 2; // damage each enemy in the EMP blast takes
export const EMP_MISSILE_LOCK = 320; // lock-on range of the homing EMP missile
export const FORCEFIELD_DURATION = 420; // gens the force-field aura lasts
export const FORCEFIELD_RADIUS = 24; // aura reach (push + melee)
export const FORCEFIELD_PUSH = 0.12; // knockback accel applied to enemies/gen
export const FORCEFIELD_DAMAGE = 1; // melee damage to an enemy caught in it
export const PORTAL_COOLDOWN = 40; // gens before a ship can re-enter a portal
export const PORTAL_PULL = 0.02; // event-horizon accel toward a nearby gate
export const PORTAL_HORIZON = 2.6; // pull reaches this × the gate radius
export const PAD_HEAL = 0.09; // HP/gen while sitting on a healing pad
// Center pad cycles which resource it yields: it holds one phase for
// CENTER_PAD_PHASE_GENS generations, then advances hp → fuel → shield → hp…
// (gen-driven so it stays in lockstep between sim and view, and tracks tempo).
export const CENTER_PAD_PHASE_GENS = 240;
export const CENTER_PAD_PHASES = ["hp", "fuel", "shield"] as const;
export type CenterPadPhase = (typeof CENTER_PAD_PHASES)[number];
export const centerPadPhase = (age: number): CenterPadPhase =>
  CENTER_PAD_PHASES[Math.floor(age / CENTER_PAD_PHASE_GENS) % 3];
// Combat XP: shattering an asteroid banks XP for the shooter; enough advances a
// level (same promotion as a rank-up pickup). XP_TO_LEVEL is indexed by current
// level-1 — the amount needed to reach the next level; L5 (ace) is capped.
export const XP_PER_ROCK = 1; // XP for shattering one asteroid with a shot
export const XP_TO_LEVEL: readonly number[] = [4, 6, 9, 13, Infinity];
export const xpForLevel = (level: number): number =>
  XP_TO_LEVEL[level - 1] ?? Infinity;
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
export const AVOID_GAIN = [0.03, 0.045, 0.07, 0.09, 0.11]; // separation from ships + rocks
export const AVOID_RADIUS = [22, 28, 34, 40, 46];
// Alignment is the murmuration driver — tuned up so squads sweep as one. Every
// rank flocks now (even rookies), with matching separation so they spread, not
// blob. Heading-match is bounded, so it yields to pursuit when an enemy is near.
export const ALIGN_GAIN = [0.07, 0.12, 0.16, 0.2, 0.24]; // match same-team heading
export const COHERE_GAIN = [0.004, 0.008, 0.012, 0.016, 0.02]; // pull toward team center
export const FLOCK_RADIUS = [38, 50, 62, 74, 86]; // wide, so alignment waves propagate
// Every rank meanders (murmuration lifeblood); higher ranks a touch livelier.
export const WANDER_GAIN = [0.03, 0.032, 0.036, 0.04, 0.045];
// Pursuit: steer toward the nearest enemy in range. Every rank now holds a gun
// standoff (KITE_DIST > 0, just inside FIRE_RANGE): they approach when beyond it
// and back off when inside it, so they settle at firing range and trade shots
// instead of boring straight through. Engage radius ≥ FIRE_RANGE so they notice
// and close from range; scrappier low ranks stand closer, aces kite farther.
export const ENGAGE_GAIN = [0.032, 0.05, 0.065, 0.085, 0.1];
export const ENGAGE_RADIUS = [95, 110, 120, 135, 150];
export const KITE_DIST = [56, 64, 72, 80, 84]; // preferred standoff (< FIRE_RANGE 95)
// Objective play: chase power-up bubbles, and when hurt peel off to a heal pad.
// L1 is a pure brawler (0); higher ranks sense farther, pull harder, and retreat
// to heal sooner — so battlefield IQ tracks rank.
export const PICKUP_SEEK_GAIN = [0, 0.022, 0.038, 0.052, 0.064];
export const PICKUP_SEEK_RADIUS = [0, 50, 78, 105, 130];
export const HEAL_SEEK_GAIN = [0, 0.03, 0.05, 0.07, 0.09];
export const HEAL_SEEK_RADIUS = [0, 60, 90, 120, 150];
export const HEAL_HP_THRESHOLD = [0, 0.35, 0.45, 0.55, 0.62]; // HP frac below → retreat
// Center-pad recovery: a depleted ship breaks for the center pad (which cycles
// hp/fuel/shield). Pull scales with how drained the ship is, so only ships past
// CENTERPAD_SEEK_THRESH worst-deficit actually detour for it.
export const CENTERPAD_SEEK_GAIN = [0, 0.032, 0.052, 0.068, 0.082];
export const CENTERPAD_SEEK_RADIUS = [0, 70, 100, 130, 165];
export const CENTERPAD_SEEK_THRESH = 0.4; // seek once worst resource deficit exceeds this
// Base-raid objective: L2+ ships steer toward enemy bases they still need to hit
// (the leveling path). L1 rookies ignore it and just brawl.
export const OBJECTIVE_GAIN = [0, 0.025, 0.04, 0.05, 0.055];
export const OBJECTIVE_RADIUS = [0, 90, 120, 150, 170];

// How much a ship *wants* a bubble kind given its current deficit. Matching-need
// bubbles read as "closer" in the seek scan, so a hurt ship favors heals and a
// shield-down ship favors shields; a healthy ship just grabs whatever is nearest.
export const wantHeal = (self: LightCycle): number =>
  self.hp < self.maxHp * 0.6 ? 2.5 : 1;
export const wantShield = (self: LightCycle): number =>
  self.maxShield > 0 && self.shield < self.maxShield * 0.5 ? 2.0 : 1;
export const wantRankUp = (self: LightCycle): number =>
  self.level < 5 ? 3.0 : 0.2; // aces don't need it
export const wantCloak = (self: LightCycle): number =>
  self.hp < self.maxHp * 0.5 ? 1.8 : 1.0; // escape want rises when hurt

// Kinds whose want is a flat constant, independent of ship state.
const FIXED_PICKUP_WANT: Partial<Record<PickupKind, number>> = {
  3: 1.6, // overcharge — aggressive want
  4: 1.4, // EMP
  7: 1.7, // force field — aggressive want
};

// Fuel cell (kind 8): only carriers harvest it. Want climbs as the carrier's
// own tank drains, so a full carrier won't detour but a thirsty one makes a
// beeline. Non-carriers return 0 → steerPickupSeek never routes them to it.
const wantFuelCell = (self: LightCycle): number =>
  isCarrier(self.archetype) ? 1 + 3 * (1 - self.fuel / self.maxFuel) : 0;

export const pickupWant = (self: LightCycle, kind: PickupKind): number => {
  switch (kind) {
    case 0:
      return wantHeal(self);
    case 1:
      return wantShield(self);
    case 5:
      return wantRankUp(self);
    case 6:
      return wantCloak(self);
    case 8:
      return wantFuelCell(self);
  }
  return FIXED_PICKUP_WANT[kind] ?? 1.2; // speed — mildly nice to have
};

// Fuel cell yield: a harvested cell tops the carrier and pumps every same-team
// ally inside FUEL_CELL_PUMP_RADIUS by the same flat amount — a mobile depot.
export const FUEL_CELL_KIND = 8;
export const FUEL_CELL_YIELD = 900; // tank units injected per harvest
export const FUEL_CELL_PUMP_RADIUS = 45; // reach of the instant team pump
export const TURN_EASE_LVL = [0.11, 0.17, 0.24, 0.3, 0.35]; // heading tracking
export const SPEED_EASE_LVL = [0.05, 0.09, 0.14, 0.18, 0.22]; // cruise control
// Passive self-repair HP/gen — deliberately slow (~4× slower than before) so a
// hull mends over tens of seconds, not a couple; heal pads / center are the
// fast option. At 45 gen/s: L1 ≈ 0.07 hp/s … L5 ≈ 1.0 hp/s.
export const REGEN_BY_LEVEL = [0.0015, 0.0045, 0.01, 0.016, 0.022];
export const SHIELD_BY_LEVEL = [1, 2, 3, 4, 5]; // secondary shield capacity
export const SPEED_BY_LEVEL = [0.65, 0.95, 1.35, 1.7, 2.0];
export const RADIUS_BY_LEVEL = [5.5, 8, 9.5, 11, 12.5]; // matches overlay sprite sizes
export const MINES_BY_LEVEL = [0, 0, 2, 3, 4]; // only L3+ carry mines

// --- Fuel: ships burn fuel to thrust, refuel at their home base -------------
export const FUEL_BASE = 1400; // L1 tank size before the archetype multiplier
export const FUEL_BURN = 1; // tank units spent per gen of thrust
export const FUEL_REFILL = 16; // units/gen refilled while docked at home base
export const FUEL_LOW_FRAC = 0.3; // hard floor: below this fraction, always refuel
// Range-aware refuel: peel off once the tank only just covers the trip to the
// nearest fuel source × this margin. Prevents ships stranding mid-map when the
// raid→center goal drags them far from home.
export const FUEL_SAFETY = 1.4;
export const FUEL_GROWTH = 0.25; // +25% tank capacity per level
export const FUEL_RETURN_GAIN = 0.09; // steering pull home when the tank runs low
export const FUEL_DRIFT_SPEED = 0.12; // dead-engine coast speed (drifts like an orb)
// Carrier fuel-sharing: a carrier tops up nearby lower-fuel allies mid-flight.
export const FUEL_SHARE_RADIUS = 30; // reach to a thirsty ally
export const FUEL_SHARE_RATE = 4; // units/gen transferred to each ally
export const FUEL_SHARE_RESERVE = 0.25; // carrier keeps this fraction for itself
// Carrier fuel-leech (unlocks at CARRIER_LEECH_LEVEL): a veteran carrier siphons
// fuel from nearby enemy ships straight into its own tank — a battlefield drain.
export const CARRIER_LEECH_LEVEL = 3; // level a carrier unlocks the leech at
export const CARRIER_LEECH_RADIUS = 26; // reach to an enemy to drain
export const CARRIER_LEECH_RATE = 6; // units/gen siphoned from each enemy in range
export const RALLY_GAIN = 0.12; // player command pull toward a beacon
export const RALLY_RADIUS = 190; // command influence reach around the beacon
export const RALLY_ARRIVE_RADIUS = 22; // slow the pull when ships reach the mark

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
    recon: boolean; // scout: shares enemy-base raid progress with allies
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
    recon: true, // the recon: broadcasts raid intel to nearby squadmates
  },
  fighter: {
    speed: 1.0,
    hp: 1.0,
    fire: 0.72,
    fuel: 1.0,
    mines: false,
    missiles: false,
    fuelShare: false,
    recon: false,
  },
  heavy: {
    speed: 0.78,
    hp: 1.5,
    fire: 1.15,
    fuel: 1.8,
    mines: true,
    missiles: false,
    fuelShare: true, // the carrier: big tank, shares with allies
    recon: false,
  },
  interceptor: {
    speed: 1.12,
    hp: 0.9,
    fire: 0.95,
    fuel: 1.0,
    mines: false,
    missiles: true,
    fuelShare: false,
    recon: false,
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
// --- Seeking missiles (L4+ heavy volley) ------------------------------------
export const MISSILE_SPEED = 2.4; // cells/gen (slower than a bolt; it homes)
export const MISSILE_TURN = 0.12; // heading ease toward the target per gen
export const MISSILE_LIFE = 90; // gens before it fizzles
export const MISSILE_RADIUS = 4; // hit radius vs a ship (plus its own radius)
export const MISSILE_DAMAGE = 2;
export const MISSILE_RANGE = 120; // lock-on distance
export const MISSILE_MIN_LEVEL = 4; // only aces carry missiles
export const MISSILE_FIRE_CHANCE = 0.02; // per-gen odds while a target is locked

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
export const isRecon = (a: Archetype): boolean => ARCHETYPE_MODS[a].recon;
// Reach over which a scout broadcasts its raid progress to same-team allies.
export const RECON_SHARE_RADIUS = 60;
export const maxFuelFor = (a: Archetype, level: number): number =>
  Math.round(
    FUEL_BASE * ARCHETYPE_MODS[a].fuel * (1 + (level - 1) * FUEL_GROWTH),
  );
/** Hits needed on EACH alive enemy base to earn the next level (grows w/ rank). */
export const baseHitsRequired = (level: number): number => level;
export const asteroidHp = (size: number): number =>
  Math.max(2, Math.round(size / 3));
