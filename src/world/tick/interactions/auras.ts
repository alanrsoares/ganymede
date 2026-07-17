import { wrapDelta } from "~/engine/physics";
import { within } from "~/world/math";
import { hit, killShip, type TickCtx } from "~/world/tick/context";
import {
  baseHitsRequired,
  CARRIER_LEECH_LEVEL,
  CARRIER_LEECH_RADIUS,
  CARRIER_LEECH_RATE,
  FORCEFIELD_DAMAGE,
  FORCEFIELD_PUSH,
  FORCEFIELD_RADIUS,
  FUEL_SHARE_RADIUS,
  FUEL_SHARE_RATE,
  FUEL_SHARE_RESERVE,
  HIT_COOLDOWN,
  isCarrier,
  isRecon,
  RECON_SHARE_RADIUS,
  SCORE_KILL,
} from "~/world/tuning";
import {
  ARENA,
  type LightCycle,
  MAX_LEVEL,
  type Mutable,
  TEAM_BASES,
} from "~/world/types";

// Broad-phase band for the ship×ship aura passes = the widest aura reach. The
// auras run after every ship has moved and none of them changes a ship's
// position (forcefield only nudges velocity), so a grid built just before them is
// exact — each aura re-gates its own smaller radius. Fits the default 480×270
// field (≥3 cells/axis), so the shipped sim exercises the grid path too.
export const AURA_BAND = Math.max(
  FORCEFIELD_RADIUS,
  FUEL_SHARE_RADIUS,
  CARRIER_LEECH_RADIUS,
  RECON_SHARE_RADIUS,
);
type NbrLists = readonly (readonly number[])[] | null;

// The "other ships" a ship at index i tests in an aura pass: its grid neighbours
// (mapped back to ships) or, with no grid built, the whole array — so each aura
// stays a single loop over one iterable.
const othersFor = (
  moved: readonly Mutable<LightCycle>[],
  nbr: NbrLists,
  i: number,
): readonly Mutable<LightCycle>[] =>
  nbr ? nbr[i].map((j) => moved[j]) : moved;

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
  const dx = wrapDelta(s.x, e.x, ARENA.w);
  const dy = wrapDelta(s.y, e.y, ARENA.h);
  const d2 = dx * dx + dy * dy;
  if (d2 >= FORCEFIELD_RADIUS * FORCEFIELD_RADIUS || d2 < 1e-3) return;
  const d = Math.sqrt(d2);
  const push = FORCEFIELD_PUSH * (1 - d / FORCEFIELD_RADIUS) * steps;
  e.vx += (dx / d) * push;
  e.vy += (dy / d) * push;
  if (e.hitCooldown > 0) return;
  hit(ctx, e, FORCEFIELD_DAMAGE, "melee", s.id);
  e.hitCooldown = HIT_COOLDOWN;
  if (e.hp <= 0) {
    ctx.score[s.colorName] += SCORE_KILL;
    killShip(ctx, e);
  }
};

/** Force-field carriers push and zap nearby enemies with a damage aura. */
export const applyForceFieldAuras = (ctx: TickCtx, nbr: NbrLists): void => {
  const { moved, removed, steps } = ctx;
  for (let i = 0; i < moved.length; i++) {
    const s = moved[i];
    if (removed.has(s.id) || s.forceFieldTime <= 0) continue;
    for (const e of othersFor(moved, nbr, i))
      forceFieldStrike(ctx, s, e, steps);
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
  if (!within(s.x, s.y, a.x, a.y, FUEL_SHARE_RADIUS)) return;
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
export const shareCarrierFuel = (ctx: TickCtx, nbr: NbrLists): void => {
  const { moved, removed, steps } = ctx;
  for (let i = 0; i < moved.length; i++) {
    const s = moved[i];
    if (removed.has(s.id) || !isCarrier(s.archetype)) continue;
    const reserve = s.maxFuel * FUEL_SHARE_RESERVE;
    for (const a of othersFor(moved, nbr, i)) {
      if (s.fuel <= reserve) break;
      shareFuelWith(s, a, removed, reserve, steps);
    }
  }
};

/** Siphon fuel from one nearby enemy `e` into the carrier `s`. */
const leechFuelFrom = (
  s: Mutable<LightCycle>,
  e: Mutable<LightCycle>,
  removed: Set<number>,
  steps: number,
): void => {
  if (removed.has(e.id) || e.colorName === s.colorName) return;
  if (e.fuel <= 0) return;
  if (!within(s.x, s.y, e.x, e.y, CARRIER_LEECH_RADIUS)) return;
  const drain = Math.min(
    CARRIER_LEECH_RATE * steps,
    e.fuel,
    s.maxFuel - s.fuel,
  );
  if (drain <= 0) return;
  e.fuel -= drain;
  s.fuel += drain;
};

/** A live carrier that has unlocked the leech and still has room in its tank. */
const canLeech = (s: Mutable<LightCycle>, removed: Set<number>): boolean =>
  !removed.has(s.id) &&
  isCarrier(s.archetype) &&
  s.level >= CARRIER_LEECH_LEVEL &&
  s.fuel < s.maxFuel;

/** Veteran carriers siphon fuel from nearby enemies into their own tank. */
export const leechCarrierFuel = (ctx: TickCtx, nbr: NbrLists): void => {
  const { moved, removed, steps } = ctx;
  for (let i = 0; i < moved.length; i++) {
    const s = moved[i];
    if (!canLeech(s, removed)) continue;
    for (const e of othersFor(moved, nbr, i)) {
      if (s.fuel >= s.maxFuel) break;
      leechFuelFrom(s, e, removed, steps);
    }
  }
};

/**
 * Merge a scout's *completed*-base raid credit into an ally's tally: for each
 * enemy base the scout has finished, credit the ally up to its own requirement.
 * Returns a fresh baseHits map, or null when nothing changes.
 */
const mergedRaidCredit = (
  scout: Mutable<LightCycle>,
  ally: Mutable<LightCycle>,
): Record<string, number> | null => {
  const allyNeed = baseHitsRequired(ally.level);
  const scoutNeed = baseHitsRequired(scout.level);
  let next: Record<string, number> | null = null;
  for (const base of TEAM_BASES) {
    if (base.name === scout.colorName) continue;
    if ((scout.baseHits[base.name] ?? 0) < scoutNeed) continue; // not finished
    if ((ally.baseHits[base.name] ?? 0) >= allyNeed) continue; // already there
    next = next ?? { ...ally.baseHits };
    next[base.name] = allyNeed;
  }
  return next;
};

/** Copy a scout's completed-raid intel onto one same-team ally in range. */
const shareReconWith = (
  scout: Mutable<LightCycle>,
  ally: Mutable<LightCycle>,
  removed: Set<number>,
): void => {
  if (ally.id === scout.id || removed.has(ally.id)) return;
  if (ally.colorName !== scout.colorName || ally.level >= MAX_LEVEL) return;
  // L5 capstone: an ace scout broadcasts raid intel map-wide (Infinity reach),
  // so a whole team can inherit its finished raids from anywhere.
  const reach = scout.level >= MAX_LEVEL ? Infinity : RECON_SHARE_RADIUS;
  if (!within(scout.x, scout.y, ally.x, ally.y, reach)) return;
  const merged = mergedRaidCredit(scout, ally);
  if (merged) ally.baseHits = merged;
};

/** Scouts broadcast their completed-raid progress to nearby same-team allies. */
export const shareReconIntel = (ctx: TickCtx, nbr: NbrLists): void => {
  const { moved, removed } = ctx;
  for (let i = 0; i < moved.length; i++) {
    const s = moved[i];
    if (removed.has(s.id) || !isRecon(s.archetype)) continue;
    // An L5 ace scout broadcasts map-wide (Infinity reach) → must scan every
    // ship; only the range-limited lower ranks can use the neighbour list.
    const others = s.level >= MAX_LEVEL ? moved : othersFor(moved, nbr, i);
    for (const a of others) shareReconWith(s, a, removed);
  }
};
