// Data model for the pure entity world (Elm architecture): entity shapes, the
// immutable World/Msg types, and the fixed field furniture. No logic lives here
// — builders and the sim step import from this module.

import type { Entity, EntityList } from "../engine/entities";
import type { Seed } from "../engine/rng";

export const DEFAULT_GRID_W = 480;
export const DEFAULT_GRID_H = 270;
export const ARENA: { w: number; h: number } = globalThis.ARENA ?? {
  w: DEFAULT_GRID_W,
  h: DEFAULT_GRID_H,
};
globalThis.ARENA = ARENA;

export function setGridBounds(w: number, h: number) {
  ARENA.w = w;
  ARENA.h = h;
}
export const MAX_LEVEL = 5;

export type Rgb = readonly [number, number, number];
export type Team = { readonly name: string; readonly rgb: Rgb };

// Up to four teams — one per edge base. A match may activate fewer (2–4) via
// MatchConfig; the first `config.teams` entries here are the ones in play.
export const TEAMS: readonly Team[] = [
  { name: "cyan", rgb: [0.0, 0.78, 1.0] },
  { name: "orange", rgb: [1.0, 0.58, 0.15] },
  { name: "emerald", rgb: [0.05, 0.92, 0.45] },
  { name: "pink", rgb: [0.92, 0.16, 0.62] },
];
export const MAX_TEAMS = TEAMS.length;
export const teamByName = new Map(TEAMS.map((t) => [t.name, t]));

// Match setup produced by the pre-game screen (or DEFAULT_CONFIG in factory).
// Carried on the World so the pure sim reads match length/format without a
// module const. `teams` activates the first N of TEAMS.
export interface MatchConfig {
  readonly teams: number; // active teams (2..MAX_TEAMS)
  readonly initialShips: number; // ships on the field at kickoff
  readonly reinforceRate: number; // reinforcement spawns per window
  readonly tempo: number; // sim generations per second
  readonly reinforceGens: number; // length of the reinforcement window
  // "standard" last-team-wins, "endless" never decides, "arcade" pilot-first
  // wave survival (see ArcadeConfig / World.arcade). Only "standard" decides a winner.
  readonly format: "standard" | "endless" | "arcade";
  readonly arcade?: ArcadeConfig; // present iff format === "arcade"
}

// --- Arcade mode: fly one ship, survive escalating waves, chase a score. ------
// The player role is Pilot in v1; the union is here so Commander/Hybrid slot in
// later without reshaping MatchConfig (see docs/arcade-mode-plan.md).
export type PlayerRole = "pilot" | "commander" | "hybrid";
export type ArcadeDifficulty = "easy" | "normal" | "hard" | "endless";

export type VictoryRule =
  | { readonly kind: "none" } // arcade score attack (v1)
  | { readonly kind: "lastTeam" } // autobattle standard
  | { readonly kind: "scoreTarget"; readonly points: number }; // future Commander

export type DefeatRule =
  | { readonly kind: "lives"; readonly count: number } // arcade pilot (v1)
  | { readonly kind: "baseDestroyed" }; // future Commander

// How each wave escalates: `spawn(wave)` yields the enemy count + level cap.
export interface WaveConfig {
  readonly intermissionMinGens: number; // breather between waves (~3s × tempo)
  readonly spawn: (wave: number) => { count: number; maxLevel: number };
}

export interface ArcadeConfig {
  readonly playerRole: PlayerRole;
  readonly difficulty: ArcadeDifficulty; // tier: sets lives + wave curve
  readonly playerTeam: string; // "cyan"
  readonly playerArchetype: Archetype;
  readonly victory: VictoryRule;
  readonly defeat: DefeatRule;
  readonly waves: WaveConfig;
  readonly enemyTeams: readonly string[]; // ["orange", "emerald"]
}

// Live arcade run state on the World (null in autobattle). `winner` stays null
// in arcade; the run ends when `over` latches (lives exhausted, ship gone).
export interface ArcadeState {
  readonly lives: number;
  readonly wave: number;
  readonly waveRemaining: number; // enemies left to kill this wave
  readonly phase: "fight" | "intermission";
  readonly intermissionGens: number; // gens elapsed in the current intermission
  readonly kills: number; // enemies destroyed this run (run stat)
  readonly startAge: number; // world.age when the run began (for elapsed time)
  readonly over: boolean; // latched once lives hit 0 → game over
  // Last-known pilot rank, stashed while alive so a respawn keeps it (dying
  // shouldn't wipe progress); the dead ship is gone by the time we respawn.
  readonly playerLevel: number;
  // Adaptive half of the moving handicap: nudged up on death, down on a clean
  // wave clear (see arcadeHandicap). `woundedWave` tracks whether the pilot has
  // died since the current wave began (so a clean clear can ease difficulty).
  readonly adapt: number;
  readonly woundedWave: boolean;
}

// Ship class archetypes. Each is a distinct hull silhouette + stat path + weapon
// tree (see ARCHETYPE_MODS in factory): scout (fast/fragile), fighter (balanced
// gunner), heavy (tank + mines), interceptor (nimble + missiles).
export const ARCHETYPES = ["scout", "fighter", "heavy", "interceptor"] as const;
export type Archetype = (typeof ARCHETYPES)[number];

// How a hit is delivered — the defender's armor soaks each type differently:
// melee = physical contact (rams, force-field, rocks/shrapnel); pierce = ranged
// energy/ordnance (bolts, missiles, mines, EMP). See ARCHETYPE_MODS + armorFor.
export type DamageType = "melee" | "pierce";

export interface LightCycle extends Entity {
  readonly x: number;
  readonly y: number;
  readonly dx: number; // heading unit vector (normalized velocity)
  readonly dy: number;
  readonly vx: number; // velocity px/gen; carries collision momentum
  readonly vy: number;
  readonly color: Rgb;
  readonly colorName: string;
  readonly level: number; // 1 basic → 5 ace (MAX_LEVEL)
  readonly angle: number; // nose faces travel dir
  readonly hp: number;
  readonly maxHp: number;
  readonly shield: number; // secondary HP layer; absorbs damage before hp
  readonly maxShield: number;
  readonly mines: number; // mine ammo (L3+); refilled at home base
  readonly maxMines: number;
  readonly beamActive: boolean;
  readonly beamX: number;
  readonly beamY: number;
  readonly beamTime: number;
  readonly hitCooldown: number; // i-frames after a dogfight pass (generations)
  readonly hitFlash: number; // gens left of the shield-impact flare (any damage)
  readonly archetype: Archetype; // class: silhouette + stat path + weapon tree
  readonly overchargeTime: number; // gens of halved fire cooldown left
  readonly invulnTime: number; // gens of cloak invulnerability left
  readonly forceFieldTime: number; // gens of push+melee force-field aura left
  readonly boostTime: number; // gens of speed boost left (speed power-up)
  readonly portalCooldown: number; // gens before this ship can portal again
  readonly fireCooldown: number; // gens before this ship can fire its next bolt
  readonly burstCount: number; // shots already fired in the current burst salvo
  readonly fuel: number; // remaining tank; 0 = no thrust, no weapons (drifts)
  readonly maxFuel: number; // tank capacity (archetype × level); refilled at home
  // Hits landed on each enemy base since the last level, keyed by base name.
  // Hit every alive enemy base `level` times → level up, then this resets.
  readonly baseHits: Readonly<Record<string, number>>;
  readonly xp: number; // combat XP toward the next level (earned breaking rocks)
}

// A weapon bolt fired by a ship at the nearest enemy. Straight-flying, team-
// tinted, spent on the first enemy-team ship it clips or when its life runs out.
export interface Bullet extends Entity {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly team: string; // shooter's team (won't hit its own team)
  readonly rgb: Rgb;
  readonly angle: number; // heading, for the tracer streak
  readonly damage: number;
  readonly life: number; // gens remaining
  readonly owner: number; // shooter ship id (credits base-raid hits back to it)
  readonly bounces: number; // ricochets left off asteroids (0 = spent on contact)
  readonly kind: number; // projectile skin (BOLT_*), chosen by shooter archetype
}

// Projectile skins, picked by shooter archetype so each class fires a visually
// distinct bolt: vulcan (orange gun round), plasma (green energy), proton (blue
// slug). The renderer maps these to their SpaceRage sprite clips.
export const BOLT_VULCAN = 0;
export const BOLT_PLASMA = 1;
export const BOLT_PROTON = 2;
/** scout/fighter → vulcan, interceptor → plasma, heavy → proton. */
export const boltKindFor = (a: Archetype): number =>
  a === "interceptor" ? BOLT_PLASMA : a === "heavy" ? BOLT_PROTON : BOLT_VULCAN;

// FX blast kinds. Explosion = ship/rock death; detonation = mine proton flash;
// muzzle = gun fire flash at the nose; impact = bolt hitting a target;
// emp = the AoE shockwave ring expanding from an EMP pickup's caster.
export const BURST_EXPLOSION = 0;
export const BURST_DETONATION = 1;
export const BURST_MUZZLE = 2;
export const BURST_IMPACT = 3;
export const BURST_EMP = 4;
export const BURST_SHIELD = 5; // base shield deflection: expanding ring + flash
export const BURST_ARC = 6; // chain-lightning bolt drawn from (x,y)→(x2,y2)
export const BURST_COUNTER = 7; // super-effective hit: bright spark on a counter-web pierce hit

export interface Burst extends Entity {
  readonly x: number;
  readonly y: number;
  readonly start: number; // performance.now() at spawn
  readonly variant: number; // which explosion clip (BURST_EXPLOSION only)
  readonly kind: number; // BURST_* — selects the clip + look
  readonly rgb?: Rgb; // team tint for muzzle/impact (others ignore it)
  readonly rot?: number; // orientation for directional FX (muzzle flash)
  readonly x2?: number; // far endpoint for arc bursts (BURST_ARC)
  readonly y2?: number;
}

// A proximity mine dropped by an L3+ ship. Stationary; arms after a delay, then
// detonates on the first enemy-team ship that enters its radius.
export interface Mine extends Entity {
  readonly x: number;
  readonly y: number;
  readonly team: string; // dropper's team (won't trigger on its own team)
  readonly rgb: Rgb;
  readonly arm: number; // gens until armed
  readonly life: number; // gens remaining
  readonly spin: number;
  readonly spinRate: number;
}

// A seeking missile: an L4+ heavy munition that homes on a locked enemy ship,
// easing its heading toward the target each gen. Slower than a bolt but it
// chases; detonates on contact for heavy damage, or expires when its life runs
// out (or its target dies and it flies straight).
export interface Missile extends Entity {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly team: string;
  readonly rgb: Rgb;
  readonly angle: number; // heading, for render + steering
  readonly targetId: number; // locked ship id (0 = lost lock, fly straight)
  readonly damage: number;
  readonly life: number;
  readonly owner: number; // shooter ship id (credits base-raid hits back to it)
  readonly blast?: number; // if set, contact detonates as AoE within this cell radius
}

// One link node of a verlet whip: its current position plus where it was last
// gen (the integrator derives velocity from that gap). Grid-cell space.
export interface WhipNode {
  readonly x: number;
  readonly y: number;
  readonly px: number;
  readonly py: number;
}

// Pilot special: a chain of linked nodes anchored to the ship's nose that whips
// out toward a target under verlet + distance-constraint physics, lashing every
// enemy a node sweeps across (once each), then retracts and expires. Persistent
// across ticks — lives in its own World pool like bullets/missiles.
export interface Whip extends Entity {
  readonly owner: number; // anchor ship id (node[0] pinned to its nose)
  readonly team: string; // owner's team (never lashes its own)
  readonly rgb: Rgb;
  readonly nodes: readonly WhipNode[]; // node[0] = anchor, last = tip
  readonly life: number; // gens remaining (lash-out then retract)
  readonly maxLife: number; // initial life, for the extend→retract envelope
  readonly damage: number; // pierce dealt per struck enemy
  readonly restLen: number; // per-segment rest length (cells)
  readonly targetId: number; // enemy the tip lashes toward (0 = aim straight)
  readonly hits: readonly number[]; // enemy ids already lashed (one hit each)
}

// A rock drifting through space. Heavy hazard: ships bounce off and take chip
// damage. `curl` bends its velocity each gen for a lazy swirl; `spinRate`
// tumbles the sprite; `variant` picks its texture.
export interface Asteroid extends Entity {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly spin: number; // current sprite rotation (rad)
  readonly spinRate: number; // rad per gen
  readonly curl: number; // velocity turn per gen (the swirl)
  readonly size: number; // half-extent in grid cells
  readonly variant: number; // which asteroid texture (0..ASTEROID_VARIANTS-1)
  readonly portalCooldown: number; // gens before it can portal again
  readonly hp: number; // integrity; 0 shatters into shrapnel
  readonly maxHp: number;
}

// Shrapnel fragment flung out when an asteroid shatters. Light + short-lived;
// clips a ship on contact, then dies. `life` counts down in generations.
export interface Projectile extends Entity {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly spin: number;
  readonly spinRate: number;
  readonly life: number;
  readonly variant: number;
}

// Power-up bubble kinds: 0 heal, 1 shield, 2 speed, 3 overcharge (rapid fire),
// 4 EMP burst (AoE), 5 rank-up (instant level), 6 cloak (invulnerability),
// 7 force field (push + melee aura that builds on the shield orb),
// 8 fuel cell — carrier-only harvest that refills the carrier and pumps nearby
// allies; the anti-stall valve that keeps a starving field from grinding out.
// ARCADE-ONLY extras (rolled only via ARCADE_PICKUP_KINDS, autobattle unchanged):
// 9 muster — reinforces the collector's team with a pair of AI allies.
// 10 drones — a short-lived escort of orbiting drones that auto-fire at enemies.
export type PickupKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export const PICKUP_KINDS = 9; // autobattle roll bound (kinds 0..8)
export const ARCADE_PICKUP_KINDS = 11; // arcade roll bound (adds 9 muster, 10 drones)
export const MUSTER_KIND = 9;
export const DRONE_KIND = 10;

// A short-lived escort drone orbiting its owner ship and auto-firing at the
// nearest enemy in range. Purely offensive/cosmetic — it never collides; its
// bolts go through the normal bullet pipeline. Dies when its life runs out or
// its owner is gone.
export interface Drone extends Entity {
  readonly x: number;
  readonly y: number;
  readonly ownerId: number; // ship it orbits (bolts credit this owner)
  readonly team: string; // owner's team — won't target its own side
  readonly rgb: Rgb; // owner's colour, for render + bolt tint
  readonly phase: number; // current orbit angle (radians)
  readonly slot: number; // 0..count-1, spaces drones evenly around the ring
  readonly life: number; // gens remaining
  readonly fireCooldown: number; // gens until the next bolt
}
export interface Pickup extends Entity {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly kind: PickupKind;
  readonly bob: number; // phase for the render bob/spin
}

// Fixed field furniture (deterministic, so it lives outside the mutable World).
export interface Pad {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}
// The arena is one live orbit around the centre "star" (CENTER_PAD). Every piece
// of field furniture sits on a single ring of radius `orbitRadius()`, spaced 45°
// apart, so all eight bodies — 4 bases + 2 portals + 2 heal pads — are the same
// distance from the star and from their neighbours (a harmonic ring). The whole
// ring rotates rigidly about the star as the match ages, so the layout stays
// perfectly symmetric (fair) while slowly turning. The radius is capped by the
// shorter (vertical) half-axis so the N/S bodies stay clear of the edge;
// ORBIT_MARGIN leaves room for their pad radius.
const ORBIT_MARGIN = 22;
// Angular velocity of the ring, radians per generation. ~0.0016 → one full
// revolution every ~3930 gens (~90s at 44 gen/s): a slow, majestic drift.
const ORBIT_OMEGA = 0.0016;
// Organic micro-drift: tiny multi-frequency perturbations layered over the
// perfect ring so it breathes and wanders like a real orbit instead of turning
// like a rigid dial. Each body gets its own phase offset (from its angle), so
// they drift independently; amplitudes are a few px, so the ring still reads as
// harmonic and near-symmetric. Frequencies are deliberately incommensurate with
// ORBIT_OMEGA so the wander never visibly repeats.
const DRIFT_RADIUS = 0.02; // fraction of r: per-body radial breathing (~±2px)
const DRIFT_ANGLE = 0.018; // rad: per-body tangential wobble (~±2px at the rim)
const DRIFT_CENTER = 3; // px: slow wander of the whole ring's centre
const OMEGA_RADIUS = 0.0007;
const OMEGA_ANGLE = 0.0009;
const OMEGA_CENTER = 0.00041;
const orbitRadius = () =>
  Math.round(Math.min(ARENA.w, ARENA.h) / 2 - ORBIT_MARGIN);
// Live ring rotation, driven off the world's age. Set once per tick (and per
// render) via setOrbitPhase so every furniture read within a frame is coherent;
// derived purely from `age`, so the sim stays deterministic. Mirrors the ARENA
// global convention — furniture is fixed data that the frame parameterises.
// `t` keeps the raw age so the micro-drift can run at its own frequencies.
export const ORBIT: { phase: number; t: number } = { phase: 0, t: 0 };
export const setOrbitPhase = (age: number) => {
  ORBIT.phase = age * ORBIT_OMEGA;
  ORBIT.t = age;
};
// A point on the star's orbit ring at `deg` clockwise from north (screen up),
// carrying the live rotation plus the organic micro-drift. Kept as sub-pixel
// floats: the ring turns only ~0.18px/gen at the rim, so rounding to whole
// world-pixels would make bodies hold still then hop a full pixel (≈4px on
// screen) — visibly jumpy. The overlay scales these by the cell size, so floats
// render as smooth motion.
const orbitPoint = (deg: number): { x: number; y: number } => {
  const base = (deg * Math.PI) / 180;
  const t = ORBIT.t;
  // Tangential wobble + radial breathing, offset per body by its slot angle.
  const a =
    base + ORBIT.phase + DRIFT_ANGLE * Math.sin(t * OMEGA_ANGLE + base * 2);
  const r =
    orbitRadius() * (1 + DRIFT_RADIUS * Math.sin(t * OMEGA_RADIUS + base * 3));
  // The whole ring's centre bobs slowly on its own little epicycle near the star.
  const cx = ARENA.w / 2 + DRIFT_CENTER * Math.sin(t * OMEGA_CENTER);
  const cy = ARENA.h / 2 + DRIFT_CENTER * Math.cos(t * OMEGA_CENTER * 1.3);
  return {
    x: cx + r * Math.sin(a),
    y: cy - r * Math.cos(a),
  };
};
// A Pad locked to one ring slot (`deg` from north) with contact radius `r`.
const orbitPad = (deg: number, r: number): Pad => ({
  get x() {
    return orbitPoint(deg).x;
  },
  get y() {
    return orbitPoint(deg).y;
  },
  r,
});

// Contested heal pads at the ring's N and S poles (the star's vertical axis) —
// one per hemisphere, symmetric so no team is favoured.
export const HEAL_PADS: readonly [Pad, Pad] = [
  orbitPad(0, 18),
  orbitPad(180, 18),
];

// Neutral centre pad — the "star" every body orbits: heals/buffs any ship over
// it, and is the level-up finish line (a ship that has raided every enemy base
// promotes when it crosses here). Equidistant from all eight ring bodies.
export const CENTER_PAD: Pad = {
  get x() {
    return Math.round(ARENA.w / 2);
  },
  get y() {
    return Math.round(ARENA.h / 2);
  },
  r: 20,
};

// Two linked gates at the ring's E and W poles — a ship entering one exits the
// other keeping its momentum. Diametrically opposite and equidistant from the
// two bases flanking each, so no team gets a private portal.
export const PORTALS: readonly [Pad, Pad] = [
  orbitPad(270, 11),
  orbitPad(90, 11),
];

// Each team's home dock — a color-tinted platform ships spawn/respawn onto.
export interface Base {
  readonly name: string;
  readonly rgb: Rgb;
  readonly x: number;
  readonly y: number;
}
// Four home docks on the ring's diagonal slots (45° between the pole pads/gates),
// each the same radius from the star as every other body. Ordered so the first
// two teams (2-player games) take the NW–SE main diagonal — maximum separation.
const BASE_ANGLE = [315, 135, 45, 225]; // cyan NW, orange SE, emerald NE, pink SW
export const TEAM_BASES: readonly Base[] = TEAMS.map((t, i) => ({
  name: t.name,
  rgb: t.rgb,
  get x() {
    return orbitPoint(BASE_ANGLE[i]).x;
  },
  get y() {
    return orbitPoint(BASE_ANGLE[i]).y;
  },
}));
export const baseByName = new Map(TEAM_BASES.map((b) => [b.name, b]));

export interface RallyBeacon {
  readonly team: string;
  readonly x: number;
  readonly y: number;
  readonly ttl: number; // gens remaining
}

export interface World {
  readonly ships: EntityList<LightCycle>;
  readonly bursts: EntityList<Burst>;
  readonly asteroids: EntityList<Asteroid>;
  readonly pickups: EntityList<Pickup>;
  readonly projectiles: EntityList<Projectile>;
  readonly mines: EntityList<Mine>;
  readonly bullets: EntityList<Bullet>;
  readonly missiles: EntityList<Missile>;
  readonly whips: EntityList<Whip>; // pilot-special verlet lash chains
  readonly drones: EntityList<Drone>; // short-lived orbiting escort drones
  readonly seed: Seed;
  readonly score: Readonly<Record<string, number>>; // points per team name
  readonly baseHp: Readonly<Record<string, number>>; // per-team base integrity
  readonly rally: RallyBeacon | null; // short-lived player command beacon
  readonly age: number; // generations elapsed; drives deterministic wander
  readonly winner: string | null; // team name once the match is decided (else null)
  readonly config: MatchConfig; // match setup (team count, length, format)
  readonly arcade: ArcadeState | null; // arcade run state (null in autobattle)
  readonly controlledShipId: number | null;
  // Enemy the piloted ship's fire hard-locks onto (arcade/manual). Auto-acquired
  // and auto-advanced by the tick; cycled by the player. null = free aim.
  readonly lockedTargetId: number | null;
  readonly controlKeys: {
    readonly up: boolean;
    readonly down: boolean;
    readonly left: boolean;
    readonly right: boolean;
    readonly space: boolean;
  };
}

export type Msg =
  | { readonly kind: "tick"; readonly steps: number; readonly now: number }
  | { readonly kind: "launch"; readonly dir: "a" | "b" | "c" | "d" }
  | { readonly kind: "drop"; readonly x: number; readonly y: number }
  | { readonly kind: "rally"; readonly x: number; readonly y: number }
  | { readonly kind: "replenish" }
  | { readonly kind: "reset" }
  | { readonly kind: "control"; readonly shipId: number | null }
  | {
      readonly kind: "controlKeys";
      readonly up: boolean;
      readonly down: boolean;
      readonly left: boolean;
      readonly right: boolean;
      readonly space: boolean;
    }
  | { readonly kind: "action"; readonly actionId: number }
  | { readonly kind: "cycleTarget"; readonly dir: 1 | -1 }
  | { readonly kind: "arcadeSkipIntermission" };

export type { Mutable } from "../engine/entities";
