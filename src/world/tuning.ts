import { durationOf, EXPLOSION_CLIPS } from "../sprites";
import {
  type ArcadeDifficulty,
  type Archetype,
  type DamageType,
  type LightCycle,
  MAX_LEVEL,
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
// Star gravity: the centre pad is a gentle, neutral (all-team) well drawing ships
// inward. Wide reach (~ the orbit-ring radius) with a soft falloff, so it's barely
// felt at the rim and firmest near the core — where the pad's hard centre deflects
// hulls, making ships swing past in arcs instead of piling in.
export const CENTER_PULL = 0.009; // inward accel at the core, easing to 0 at the rim
export const CENTER_HORIZON = 6; // pull reaches this × the centre pad radius (~120px)
export const PAD_HEAL = 0.09; // HP/gen while sitting on a healing pad
// Center pad cycles which resource it yields: it holds one phase for
// CENTER_PAD_PHASE_GENS generations, then advances hp → fuel → shield → hp…
// (gen-driven so it stays in lockstep between sim and view, and tracks tempo).
export const CENTER_PAD_PHASE_GENS = 240;
export const CENTER_PAD_PHASES = ["hp", "fuel", "shield"] as const;
export type CenterPadPhase = (typeof CENTER_PAD_PHASES)[number];
export const centerPadPhase = (age: number): CenterPadPhase =>
  CENTER_PAD_PHASES[Math.floor(age / CENTER_PAD_PHASE_GENS) % 3];
// Solid collision radius of the center pad's core (the faceted dais). Kept well
// inside CENTER_PAD.r (the buff/finish trigger, 20) so bodies bounce off the
// core while a ship can still hug the surrounding donut to heal and cash in.
export const CENTER_PAD_RADIUS = 7;
// Combat XP: shattering an asteroid banks XP for the shooter; enough advances a
// level (same promotion as a rank-up pickup). XP_TO_LEVEL is indexed by current
// level-1 — the amount needed to reach the next level; L5 (ace) is capped.
export const XP_PER_ROCK = 1; // XP for shattering one asteroid with a shot
export const XP_TO_LEVEL: readonly number[] = [3, 6, 10, 15, Infinity];
// XP banked per hit landed on an enemy base (bolt, missile, or rammer slam). The
// raid is the core loop ships spend most time on, so it's the steadiest leveling
// stream — uncapped (the aggressive objective ranks to ace) and non-healing.
export const BASE_RAID_XP = 1;
// Rock XP is a catch-up trickle, not a solo carry: it can only rank a ship up to
// this level. Ranks past here require earned combat — killing enemies (killXp,
// uncapped) or the base-raid path — so the safe PvE farm never out-values the
// contested objective. Rock XP still banks at the cap but can't cross it.
export const XP_LEVEL_CAP = 3;

// Kill XP scales with the *level delta* between killer and victim, so leveling
// rewards punching up and starves the snowball (a veteran farming rookies barely
// ranks — the economic half of the anti-runaway lever; focus-fire on veterans is
// the tactical half). Killing a juicier (higher) prey is worth more; a pubstomp
// floors at XP_KILL_MIN. Reference matrix (killer level → victim level), rounded:
//
//   killer\victim  L1   L2   L3   L4   L5
//        L1         2    3    5    6    8
//        L2         1    2    4    5    7
//        L3         1    1    3    4    6
//        L4         1    1    2    3    5
//
// At thresholds [4,6,9,13]: even-level kills ~2-3 → a level; an upset can jump a
// rank in one or two kills; stomping down nets the L1 floor. Partial damage banks
// a pro-rata slice of these (see awardCombatXp), so chip damage counts too.
export const XP_KILL_BASE = 1.5; // baseline value of an even-level kill
export const XP_KILL_VICTIM = 0.5; // + per victim level above L1 (juicier prey)
export const XP_KILL_UPSET = 1.0; // + per level the victim outranks the killer
export const XP_KILL_MIN = 1; // a kill always banks at least this
export const XP_KILL_MAX = 8; // cap on a single kill (an L1→L5 giant-slaying)
export const killXp = (killerLevel: number, victimLevel: number): number =>
  Math.max(
    XP_KILL_MIN,
    Math.min(
      XP_KILL_MAX,
      Math.round(
        XP_KILL_BASE +
          XP_KILL_VICTIM * (victimLevel - 1) +
          XP_KILL_UPSET * (victimLevel - killerLevel),
      ),
    ),
  );
export const xpForLevel = (level: number): number =>
  XP_TO_LEVEL[level - 1] ?? Infinity;

// Autobattle only: combat-XP leveling gets progressively harder as the match
// ages, so early ranks come fast but late-game promotion via kills/rocks/raid-XP
// slows — a time brake on the snowball. Arcade paces itself by wave, so it opts
// out (scale 1). Applied to the XP threshold in awardXp (context.ts).
export const LEVELUP_RAMP_GENS = 900; // ~20s at 45 gen/s per +1 ramp step
export const LEVELUP_RAMP_STEP = 0.5; // +50% of the base requirement per step
export const LEVELUP_RAMP_MAX = 3; // cap the requirement at 3× its base
export const levelUpScale = (
  age: number,
  format: MatchConfig["format"],
): number => {
  if (format === "arcade") return 1;
  const steps = Math.floor(Math.max(0, age) / LEVELUP_RAMP_GENS);
  return Math.min(LEVELUP_RAMP_MAX, 1 + steps * LEVELUP_RAMP_STEP);
};
export const HOME_RADIUS = 12; // over own base -> chance to promote
export const BASE_MAX_HP = 24; // base integrity; 0 = team eliminated
export const BASE_RADIUS = 11; // solid collision radius of a base
export const BASE_HEAL_RATE = 0.05; // base HP/gen while an ally sits on it
export const BASE_RAM_DAMAGE = 1; // base HP lost per enemy ram (behind i-frames)
// Base gravity well: an intact base pulls its own ships home and repels
// intruders. Reach tracks the inward force-field visual; both scale with the
// base's remaining integrity, so a crumbling base loses its grip.
export const BASE_PULL = 0.02; // ally inward accel inside the field
export const BASE_PUSH = 0.028; // enemy outward accel (repelled from the base)
export const BASE_HORIZON = 1.4; // field reach as a multiple of BASE_RADIUS
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
// Per-bolt damage grows with rank so gun offense keeps pace with the ~3.3× HP
// growth L1→L5 (hull + shield). Without this, veteran fights got grindy since
// only cadence/range scaled while pools ballooned. Indexed by level-1.
export const BULLET_DAMAGE_BY_LEVEL = [1, 1.15, 1.3, 1.45, 1.6];
export const bulletDamageFor = (level: number): number =>
  BULLET_DAMAGE_BY_LEVEL[level - 1] ?? BULLET_DAMAGE_BY_LEVEL[0];
// Ricochet: a bolt deflects off a surviving asteroid this many times before it
// is spent, turning rocks into cover that skips fire around the field. Chips
// the rock on every bounce; a rock it shatters absorbs the bolt regardless.
export const BULLET_RICOCHETS = 1;
export const FIRE_RANGE = 95; // base reference; real reach = fireRangeFor(...)
// Per-archetype bolt reach so the range axis expresses role, not just level:
// the tank/brawler heavy fires short (must close), skirmishers reach farther.
// Multiplies bolt lifetime (→ range). Kept so fireRangeFor stays under reach.
export const BOLT_RANGE_MULT: Record<Archetype, number> = {
  scout: 1.12,
  fighter: 1.0,
  heavy: 0.85,
  interceptor: 1.1,
};
// Fire cadence tightens with rank: aces spit bolts ~2.5× as fast as rookies.
const FIRE_COOLDOWN_BY_LEVEL = [90, 74, 60, 48, 38]; // gens between shots
export const fireCooldownForLevel = (level: number): number =>
  FIRE_COOLDOWN_BY_LEVEL[level - 1] ?? FIRE_COOLDOWN_BY_LEVEL[0];
// Bolt reach grows with rank: a bolt lives longer (flies farther) each level, so
// veterans out-range rookies — the "leveling up increases range" half (cadence
// above is the "increases frequency" half).
export const BULLET_RANGE_GROWTH = 0.13; // +13% bolt lifetime per level over L1
export const bulletLifeFor = (level: number, archetype?: Archetype): number =>
  Math.round(
    BULLET_LIFE *
      (1 + (level - 1) * BULLET_RANGE_GROWTH) *
      (archetype ? BOLT_RANGE_MULT[archetype] : 1),
  );
// Actual bolt reach in cells (speed × lifetime), archetype- and level-aware.
export const boltRange = (level: number, archetype?: Archetype): number =>
  BULLET_SPEED * bulletLifeFor(level, archetype);
// Engagement reach: ships open fire at 90% of their bolt's actual range, so the
// range axis (level growth + archetype reach) is *felt* — veterans and long-reach
// hulls fire sooner/farther, brawler heavies must close. Always < boltRange, so
// a bolt fired at the fire boundary still reaches its mark.
export const fireRangeFor = (level: number, archetype?: Archetype): number =>
  Math.round(boltRange(level, archetype) * 0.9);

// --- Per-archetype firing patterns ------------------------------------------
// Each class shoots differently: a "single" bolt, a "parallel" salvo of wing-
// mounted barrels fired abreast (wide hulls), or a "burst" — a quick stream of
// shots then a longer reload. Barrels/spread describe the parallel fan; burst
// size + gap describe the stream. See fireWeapon (interactions.ts).
export type WeaponPattern = "single" | "parallel" | "burst";
export interface WeaponProfile {
  readonly pattern: WeaponPattern;
  readonly barrels: number; // parallel: bolts fired side-by-side (≥1)
  readonly spread: number; // parallel: perpendicular spacing per barrel (cells)
  readonly burstShots: number; // burst: shots in one salvo before the reload
  readonly burstGap: number; // burst: gens between shots within the salvo
}
export const WEAPON_PROFILES: Record<Archetype, WeaponProfile> = {
  // Nimble harasser: one bolt, but the fastest cadence (see fireCooldown).
  scout: {
    pattern: "single",
    barrels: 1,
    spread: 0,
    burstShots: 1,
    burstGap: 0,
  },
  // Balanced gunner: twin cannons firing abreast.
  fighter: {
    pattern: "parallel",
    barrels: 2,
    spread: 3,
    burstShots: 1,
    burstGap: 0,
  },
  // Wide hull: a broad three-barrel wing volley — the parallel-fire showcase.
  heavy: {
    pattern: "parallel",
    barrels: 3,
    spread: 5,
    burstShots: 1,
    burstGap: 0,
  },
  // Strike craft: a rapid three-shot burst, then a reload beat.
  interceptor: {
    pattern: "burst",
    barrels: 1,
    spread: 0,
    burstShots: 3,
    burstGap: 6,
  },
};
// Weapon profile for a ship, with the L5 fighter capstone folded in: an ace
// fighter mounts a third parallel barrel (2 → 3), widening its abreast volley.
export const weaponFor = (a: Archetype, level: number): WeaponProfile => {
  const wp = WEAPON_PROFILES[a];
  if (a === "fighter" && level >= MAX_LEVEL) {
    return { ...wp, barrels: wp.barrels + 1 };
  }
  return wp;
};
// The L5 fighter's third barrel used to nearly double its DPS — a spike, not a
// bump. Pair the extra barrel with a slower cadence so the capstone reads as a
// wider volley, not a firehose (see fireCooldownFor).
export const FIGHTER_CAPSTONE_FIRE_MULT = 1.4;

// Arcade aim assist (Easy/Normal only): when a piloted shot's direction lands
// within a narrow cone of a nearby enemy, bias the bolt toward it. Subtle — the
// player still chooses the direction; this only forgives small misses.
export const AIM_ASSIST_CONE_COS = Math.cos((15 * Math.PI) / 180); // ±15° cone
export const AIM_ASSIST_BIAS = 0.5; // 0 = none, 1 = full snap onto the target
export const AIM_ASSIST_RANGE = 130; // px; only assist toward enemies this close

// Longest explosion variant — bursts live at least this long so none clip early.
export const EXPLOSION_DURATION = Math.max(...EXPLOSION_CLIPS.map(durationOf));

// --- Per-level stat tables (indexed by level-1) -----------------------------
// Movement smarts unlock with rank: each rank dodges better, flocks tighter, and
// regulates speed/heading more precisely; L5 is a coordinated ace.
// Separation from ships + rocks. Omnidirectional for ships (see steerSeparation),
// so these hold a personal-space bubble on every side, not just ahead.
export const AVOID_GAIN = [0.036, 0.055, 0.085, 0.11, 0.13];
export const AVOID_RADIUS = [26, 32, 38, 44, 50];
// Alignment is the murmuration driver — tuned up so squads sweep as one. Every
// rank flocks now (even rookies), with matching separation so they spread, not
// blob. Heading-match is bounded, so it yields to pursuit when an enemy is near.
export const ALIGN_GAIN = [0.07, 0.12, 0.16, 0.2, 0.24]; // match same-team heading
export const COHERE_GAIN = [0.003, 0.006, 0.009, 0.012, 0.015]; // pull toward team center (loosened so squads don't blob)
export const FLOCK_RADIUS = [38, 50, 62, 74, 86]; // wide, so alignment waves propagate
// Every rank meanders (murmuration lifeblood); higher ranks a touch livelier.
export const WANDER_GAIN = [0.03, 0.032, 0.036, 0.04, 0.045];
// Pursuit: steer toward the nearest enemy in range. Every rank now holds a gun
// standoff (KITE_DIST > 0, just inside FIRE_RANGE): they approach when beyond it
// and back off when inside it, so they settle at firing range and trade shots
// instead of boring straight through. Engage radius ≥ FIRE_RANGE so they notice
// and close from range; scrappier low ranks stand closer, aces kite farther.
export const ENGAGE_GAIN = [0.05, 0.075, 0.1, 0.12, 0.14];
export const ENGAGE_RADIUS = [95, 110, 120, 135, 150];
export const KITE_DIST = [56, 64, 72, 80, 84]; // preferred standoff (< FIRE_RANGE 95)
// L3+ ships coordinate: they focus-fire (and pursue) the weakest enemy in range
// so allies converge on one target. Lower ranks fight solo (nearest threat).
export const COORDINATE_MIN_LEVEL = 3;
// Concave surround: while charging a target, a pressing ship also drifts
// sideways (perpendicular to its approach), split to opposite flanks by ship-id
// parity, so a squad fans onto an arc around the enemy instead of stacking into
// a column — more hulls reach the front at once. The sideways pull fades to a
// straight ram inside CONCAVE_COMMIT_DIST so ships still close and connect.
export const CONCAVE_GAIN = 0.7; // tangential strength relative to the approach
export const CONCAVE_COMMIT_DIST = 42; // within this range, commit straight in
// While a ship is committed — an enemy in engage range, or an active objective /
// rally / refuel run — its flocking urges (align, cohere, wander) are damped to
// this fraction so formation-keeping can't drag it off the fight or the goal.
// Full murmuration returns only when the ship is idle.
export const COMBAT_FLOCK_DAMP = 0.3;
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
export const OBJECTIVE_GAIN = [0, 0.05, 0.075, 0.09, 0.1];
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
export const RADIUS_BY_LEVEL = [4.5, 5.9, 7.0, 8.1, 9.2]; // matches overlay sprite sizes; L5/L1 = 2.04x
export const MINES_BY_LEVEL = [0, 0, 2, 3, 4]; // only L3+ carry mines

// --- Fuel: ships burn fuel to thrust, refuel at their home base -------------
export const FUEL_BASE = 1400; // L1 tank size before the archetype multiplier
export const FUEL_BURN = 1.5; // tank units spent per gen of thrust
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
    meleeDmg: number; // base ram damage on contact (before counter + level scale)
    counters: Archetype; // class this one gets the melee/aggression bonus against
    rammer: boolean; // brawler: closes to contact + rams bases for extra damage
    meleeResist: number; // 0..1 melee armor — physical/ram damage soaked
    pierceArmor: number; // 0..1 pierce armor — ranged bolt/missile/blast soaked
    pierceShred: number; // 0..1 fraction of the target's pierce armor this class's bolts ignore
    arc: boolean; // fires chain-lightning at its rank capstone (ARC_MIN_LEVEL)
  }
> = {
  // Counter loop (each beats the next): scout → interceptor → heavy → fighter →
  // scout. A ship that counters its foe rams harder and presses in; one that is
  // countered chips lightly and holds off (see meleeDamage + combatAggression).
  scout: {
    speed: 1.3,
    hp: 0.85, // T2: thin but no longer glass — a real skirmisher
    fire: 0.9,
    fuel: 0.8,
    mines: false,
    missiles: false,
    fuelShare: false,
    recon: true, // the recon: broadcasts raid intel to nearby squadmates
    meleeDmg: 0.6, // fragile harasser — bad rammer
    counters: "interceptor", // fast enough to run down the glass-cannon
    rammer: false,
    meleeResist: 0, // paper hull — takes rams full in the teeth
    pierceArmor: 0, // …and full bolts too
    pierceShred: 0.5, // T2: armor-shredder — its bolts skip half the target's plating
    arc: false,
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
    meleeDmg: 1.0, // balanced baseline
    counters: "scout", // gunner shreds the fragile scout
    rammer: false,
    meleeResist: 0.1,
    pierceArmor: 0.15,
    pierceShred: 0, // gunner leans on cadence, not armor-piercing
    arc: true, // L5 capstone: the gunner's chain-lightning overload
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
    meleeDmg: 1.7, // the bruiser — crushes on contact
    counters: "fighter", // tank walks through the fighter's fire
    rammer: true, // the melee ship: charges enemies, slams bases
    meleeResist: 0.5, // reinforced hull — shrugs off half of every ram
    pierceArmor: 0.45, // heavy plating — eats most incoming fire (the tank)
    pierceShred: 0, // blunt slugs, not piercing rounds
    arc: false,
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
    meleeDmg: 0.9,
    counters: "heavy", // missiles chase down the slow heavy
    rammer: false,
    meleeResist: 0.05,
    pierceArmor: 0.1,
    pierceShred: 0.15, // light discarding-sabot missiles nick the heavy's plating
    arc: false,
  },
};

// --- Counter-web combat: melee damage + survival-balanced aggression ---------
export const MELEE_COUNTER_MULT = 1.75; // ram bonus when attacker counters the target
// T1: bolts/missiles hit harder against the class this shooter counters, so the
// rock-paper-scissors web bites for gunners too (not just rammers). Applied in
// the central `hit` choke point for pierce damage.
export const PIERCE_COUNTER_MULT = 1.35;
export const MELEE_LEVEL_SCALE = 0.12; // +12% ram damage per level above L1

// Focus-fire priority (higher = more attractive target): a blend of "finish the
// wounded" (low hp) and "gang the veteran" (high level). The level term is the
// tactical half of the anti-runaway lever — a leader draws fire instead of
// snowballing untouched — while the hp term keeps the squad finishing kills. The
// bounty is tuned so a *wounded* veteran is prized but a *full-hp* tank isn't
// dived (its high hp still outweighs the bounty). See focusEnemy / pickFoe.
export const TARGET_VETERAN_BOUNTY = 0.8; // hp-equivalent worth of each victim level
export const targetPriority = (ship: LightCycle): number =>
  ship.level * TARGET_VETERAN_BOUNTY - ship.hp;

/** Does this class actively ram — close to contact and slam bases? */
export const isRammer = (a: Archetype): boolean => ARCHETYPE_MODS[a].rammer;

/** Does this class fire chain-lightning at its capstone rank? */
export const carriesArc = (a: Archetype): boolean => ARCHETYPE_MODS[a].arc;

// Chain-lightning capstone weapon: a hitscan tesla arc that strikes the nearest
// enemy in ARC_RANGE, then keeps forking — each link jumps to the nearest
// unstruck enemy within ARC_CHAIN_RANGE of the last node, up to ARC_MAX_LINKS
// nodes, with the bolt's damage decaying ARC_CHAIN_FALLOFF× per hop. Deterministic
// per-gen proc (seeded), pierce damage per node. Rendered as jagged BURST_ARCs.
// Design: a SHORT-range brawler weapon whose payoff is the chain, not the reach.
// The primary strike only lands up close (ARC_RANGE ≪ FIRE_RANGE), but once it
// connects the bolt forks across the swarm — each hop reaches ARC_CHAIN_RANGE
// (≥ the primary reach) so a single close hit can sweep a whole cluster. Gated
// to L2+ with a modest proc so it reads as a distinct close-in tesla, not a
// sniper beam.
export const ARC_MIN_LEVEL = 2; // shows up before the L5 capstone
export const ARC_FIRE_CHANCE = 0.08; // proc chance per eligible gen
export const ARC_RANGE = 34; // short primary reach — must close to strike
export const ARC_CHAIN_RANGE = 44; // per-hop fork reach (≥ primary → chains outward)
export const ARC_MAX_LINKS = 6; // total struck nodes (primary + up to 5 forks)
export const ARC_CHAIN_FALLOFF = 0.8; // bolt damage × this each successive hop
export const ARC_DAMAGE = 2; // pierce damage dealt at the primary node

// Rammers hit bases harder on a hull slam; everyone else does the flat ram.
export const BASE_RAM_MULT = 3; // rammer base-ram multiplier over BASE_RAM_DAMAGE

// L5 capstone — the ace rammer's hull slam sets off an area shockwave (reuses the
// EMP blast: damages + kills nearby enemies, credits XP to the rammer). Turns a
// veteran heavy into a melee area-bruiser. See maybeRamShock (context.ts).
export const RAM_SHOCK_DAMAGE = 2; // shockwave damage to each enemy in reach
export const RAM_SHOCK_RADIUS = 30; // shockwave reach in cells

/** Base integrity a ship strips per hull ram (rammers slam far harder). */
export const baseRamDamage = (s: LightCycle): number =>
  BASE_RAM_DAMAGE * (isRammer(s.archetype) ? BASE_RAM_MULT : 1);

/**
 * Raw ram damage `attacker` deals to `defender`: base × counter bonus × level
 * scale. This is the attacker-side output only — the defender's melee armor is
 * applied centrally when the hit lands (see `hit` → armorFor), so every damage
 * type passes through one armor choke point.
 */
export const meleeDamage = (
  attacker: LightCycle,
  defender: LightCycle,
): number => {
  const mods = ARCHETYPE_MODS[attacker.archetype];
  const counter = mods.counters === defender.archetype ? MELEE_COUNTER_MULT : 1;
  const levelScale = 1 + (attacker.level - 1) * MELEE_LEVEL_SCALE;
  return mods.meleeDmg * counter * levelScale;
};

/** Fraction of an incoming hit soaked by `a`'s armor for the given damage type. */
export const armorFor = (a: Archetype, type: DamageType): number =>
  type === "melee"
    ? ARCHETYPE_MODS[a].meleeResist
    : ARCHETYPE_MODS[a].pierceArmor;

// Aggression gate: scales combat pursuit so ships fight hard only when it's safe
// and favorable, otherwise deferring to survival + raid(level-up) steering.
export const AGGRO_MIN = 0.3; // floor — a cornered ship still defends itself
export const AGGRO_MAX = 1.5; // ceiling — a fresh, favored ship presses hardest
export const AGGRO_FAVOR = 1.3; // matchup multiplier when self counters the foe
export const AGGRO_FEAR = 0.5; // matchup multiplier when the foe counters self

/**
 * How hard `self` should press a fight with `foe`, in [AGGRO_MIN, AGGRO_MAX].
 * Folds three restraints so aggression never overrides survival or leveling:
 *  - health: a hurt ship backs off (peels to heal / keeps chasing its raid);
 *  - fuel: a near-dry ship won't burn its tank on a chase (lets refuel win);
 *  - matchup: press a foe you counter, shy from one that counters you.
 */
export const combatAggression = (self: LightCycle, foe: LightCycle): number => {
  const health = self.maxHp > 0 ? self.hp / self.maxHp : 1;
  const fuel = self.maxFuel > 0 ? self.fuel / self.maxFuel : 1;
  const fuelFactor = 0.5 + 0.5 * Math.min(1, fuel / 0.5); // 1 at half-tank+, 0.5 dry
  let matchup = 1;
  if (ARCHETYPE_MODS[self.archetype].counters === foe.archetype) {
    matchup = AGGRO_FAVOR;
  } else if (ARCHETYPE_MODS[foe.archetype].counters === self.archetype) {
    matchup = AGGRO_FEAR;
  }
  const raw = health * fuelFactor * matchup;
  return Math.max(AGGRO_MIN, Math.min(AGGRO_MAX, raw));
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
export const MISSILE_MIN_LEVEL = 3; // T3: interceptor spikes at veteran, not ace
export const MISSILE_FIRE_CHANCE = 0.02; // per-gen odds while a target is locked

// Archetype-aware stats: base per-level value × the class modifier.
export const cruiseFor = (a: Archetype, level: number): number =>
  speedForLevel(level) * ARCHETYPE_MODS[a].speed;
export const maxHpFor = (a: Archetype, level: number): number =>
  Math.max(1, Math.round(maxHpForLevel(level) * ARCHETYPE_MODS[a].hp));
export const fireCooldownFor = (a: Archetype, level: number): number => {
  const base = fireCooldownForLevel(level) * ARCHETYPE_MODS[a].fire;
  return a === "fighter" && level >= MAX_LEVEL
    ? base * FIGHTER_CAPSTONE_FIRE_MULT
    : base;
};
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

// --- Arcade mode ------------------------------------------------------------
// Pilot-first wave survival, in four difficulty tiers. Each tier sets starting
// lives, the inter-wave breather, and the escalation curve (enemy count + level
// cap grow with the wave). See docs/arcade-mode-plan.md.
export const ARCADE_LIVES = 3; // legacy default (Normal supersedes it)
export const ARCADE_INTERMISSION_GENS = 3 * 45; // ~3s at 45 gen/s

export type WaveSpawn = { count: number; maxLevel: number };
export interface ArcadeTier {
  readonly key: ArcadeDifficulty;
  readonly label: string;
  readonly blurb: string;
  readonly lives: number;
  readonly intermissionGens: number;
  readonly spawn: (wave: number) => WaveSpawn;
}
const levelCap = (wave: number, per: number): number =>
  Math.min(MAX_LEVEL, 1 + Math.floor(wave / per));
export const ARCADE_TIERS: Record<ArcadeDifficulty, ArcadeTier> = {
  easy: {
    key: "easy",
    label: "Easy",
    blurb: "5 lives · gentle ramp",
    lives: 5,
    intermissionGens: 4 * 45,
    spawn: (w) => ({ count: 1 + w, maxLevel: levelCap(w, 3) }),
  },
  normal: {
    key: "normal",
    label: "Normal",
    blurb: "4 lives · a fair fight",
    lives: 4,
    intermissionGens: 3 * 45,
    spawn: (w) => ({ count: 2 + w, maxLevel: levelCap(w, 2) }),
  },
  hard: {
    key: "hard",
    label: "Hard",
    blurb: "3 lives · swarms fast",
    lives: 3,
    intermissionGens: 3 * 45,
    spawn: (w) => ({ count: 3 + w, maxLevel: levelCap(w, 2) }),
  },
  endless: {
    key: "endless",
    label: "Endless",
    blurb: "3 lives · relentless",
    lives: 3,
    intermissionGens: 2 * 45,
    spawn: (w) => ({
      count: 2 + Math.floor(w * 1.5),
      maxLevel: levelCap(w, 1),
    }),
  },
};
// Back-compat: the original fixed curve is now the Hard tier's.
export const arcadeWaveSpawn = ARCADE_TIERS.hard.spawn;
