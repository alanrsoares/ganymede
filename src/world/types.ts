// Data model for the pure entity world (Elm architecture): entity shapes, the
// immutable World/Msg types, and the fixed field furniture. No logic lives here
// — builders and the sim step import from this module.

import type { Entity, EntityList } from "../engine/entities";
import type { Seed } from "../engine/rng";

export const GRID_W = 480;
export const GRID_H = 270;
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
  readonly format: "standard" | "endless"; // endless never decides a winner
}

// A cell written into the CA grid: [x, y, state]. State 1 = spark, 3 = debris.
export type Cell = readonly [number, number, number];
export interface Cmd {
  readonly inject: readonly Cell[];
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
}

// FX blast kinds. Explosion = ship/rock death; detonation = mine proton flash;
// muzzle = gun fire flash at the nose; impact = bolt hitting a target;
// emp = the AoE shockwave ring expanding from an EMP pickup's caster.
export const BURST_EXPLOSION = 0;
export const BURST_DETONATION = 1;
export const BURST_MUZZLE = 2;
export const BURST_IMPACT = 3;
export const BURST_EMP = 4;
export const BURST_SHIELD = 5; // base shield deflection: expanding ring + flash

export interface Burst extends Entity {
  readonly x: number;
  readonly y: number;
  readonly start: number; // performance.now() at spawn
  readonly variant: number; // which explosion clip (BURST_EXPLOSION only)
  readonly kind: number; // BURST_* — selects the clip + look
  readonly rgb?: Rgb; // team tint for muzzle/impact (others ignore it)
  readonly rot?: number; // orientation for directional FX (muzzle flash)
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
export type PickupKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const PICKUP_KINDS = 9;
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
export const HEAL_PADS: readonly Pad[] = [
  { x: 120, y: 200, r: 18 },
  { x: 360, y: 70, r: 18 },
];
// Neutral center pad: heals/buffs any ship over it, and is the level-up finish
// line — a ship that has raided every enemy base promotes when it crosses here.
export const CENTER_PAD: Pad = { x: 240, y: 135, r: 20 };
// Two linked gates; a ship entering one exits the other keeping its momentum.
export const PORTALS: readonly [Pad, Pad] = [
  { x: 70, y: 60, r: 13 },
  { x: 410, y: 210, r: 13 },
];

// Each team's home dock — a color-tinted platform ships spawn/respawn onto.
export interface Base {
  readonly name: string;
  readonly rgb: Rgb;
  readonly x: number;
  readonly y: number;
}
const BASE_POS: readonly (readonly [number, number])[] = [
  [45, 135],
  [435, 135],
  [240, 32],
  [240, 238],
];
export const TEAM_BASES: readonly Base[] = TEAMS.map((t, i) => ({
  name: t.name,
  rgb: t.rgb,
  x: BASE_POS[i][0],
  y: BASE_POS[i][1],
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
  readonly seed: Seed;
  readonly score: Readonly<Record<string, number>>; // points per team name
  readonly baseHp: Readonly<Record<string, number>>; // per-team base integrity
  readonly rally: RallyBeacon | null; // short-lived player command beacon
  readonly age: number; // generations elapsed; drives deterministic wander
  readonly winner: string | null; // team name once the match is decided (else null)
  readonly config: MatchConfig; // match setup (team count, length, format)
}

export type Msg =
  | { readonly kind: "tick"; readonly steps: number; readonly now: number }
  | { readonly kind: "launch"; readonly dir: "a" | "b" | "c" | "d" }
  | { readonly kind: "drop"; readonly x: number; readonly y: number }
  | { readonly kind: "rally"; readonly x: number; readonly y: number }
  | { readonly kind: "replenish" }
  | { readonly kind: "reset" };

export type { Mutable } from "../engine/entities";
