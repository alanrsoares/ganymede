import { toroidalDist, wrap, wrapDelta } from "~/engine/physics";
import { BASE_MAX_HP, baseHitsRequired, DEFAULT_CONFIG } from "./tuning";
import {
  ARENA,
  type LightCycle,
  type MatchConfig,
  TEAM_BASES,
  TEAMS,
} from "./types";

export { toroidalDist, wrap, wrapDelta };

// --- Field-bound wrapping ----------------------------------------------------
// Every position in the sim lives on ARENA, whose origin and per-axis topology
// `syncField` sets. These bind the raw physics helpers to the live field so no
// call site has to remember which axis wraps: pass coordinates, get the right
// answer for the topology in play. All-range mode wraps both axes at origin
// 0,0, which is what they did before the field grew an origin.

/** Fold an x coordinate into the field (identity while x is open). */
export const wrapX = (v: number): number =>
  ARENA.wrapX ? wrap(v, ARENA.w, ARENA.x0) : v;

/** Fold a y coordinate into the field (identity while y is open). */
export const wrapY = (v: number): number =>
  ARENA.wrapY ? wrap(v, ARENA.h, ARENA.y0) : v;

/** Signed shortest delta along x, across the seam only if x wraps. */
export const deltaX = (a: number, b: number): number =>
  wrapDelta(a, b, ARENA.w, ARENA.wrapX);

/** Signed shortest delta along y, across the seam only if y wraps. */
export const deltaY = (a: number, b: number): number =>
  wrapDelta(a, b, ARENA.h, ARENA.wrapY);

/** Unsigned distance along x, across the seam only if x wraps. */
export const distX = (a: number, b: number): number =>
  toroidalDist(a, b, ARENA.w, ARENA.wrapX);

/** Unsigned distance along y, across the seam only if y wraps. */
export const distY = (a: number, b: number): number =>
  toroidalDist(a, b, ARENA.h, ARENA.wrapY);

/**
 * Hold `x` inside the field, leaving `margin` of clearance at each edge. A
 * no-op while x wraps, so this only bites on a scroll stage — and there it is
 * applied to the player alone: walls the AI can feel would have enemies sliding
 * along invisible edges instead of strafing in and out of the sides.
 */
export const clampFieldX = (x: number, margin = 0): number =>
  ARENA.wrapX
    ? x
    : Math.min(Math.max(x, ARENA.x0 + margin), ARENA.x0 + ARENA.w - margin);

/** Squared distance between two field points (topology-aware, no sqrt). */
export function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = distX(ax, bx);
  const dy = distY(ay, by);
  return dx * dx + dy * dy;
}

/** True when `(ax,ay)` and `(bx,by)` lie within radius `r` on the wrapped field. */
export const within = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
): boolean => distSq(ax, ay, bx, by) < r * r;

/** Apply `amt` damage: the shield soaks it first, the rest spills to hull HP. */
export function applyHit(s: { shield: number; hp: number }, amt: number): void {
  const soaked = Math.min(s.shield, amt);
  s.shield -= soaked;
  s.hp -= amt - soaked;
}

/** A fresh scoreboard with every team at zero. */
export const zeroScores = (): Record<string, number> =>
  Object.fromEntries(TEAMS.map((t) => [t.name, 0]));

/**
 * Base integrity map at kickoff: active teams at full HP, inactive teams (past
 * `config.teams`) at 0 so every "base alive" filter treats them as eliminated.
 */
export const fullBaseHp = (
  config: MatchConfig = DEFAULT_CONFIG,
): Record<string, number> =>
  Object.fromEntries(
    TEAMS.map((t, i) => [t.name, i < config.teams ? BASE_MAX_HP : 0]),
  );

/**
 * True once `self` has hit every *alive* enemy base at least `baseHitsRequired`
 * times — the raid half of the level-up goal. False when no enemy base remains
 * to raid. Shared by the promotion check, the AI's center-finish steering, and
 * the render-time "primed" marker.
 */
export const hasRaidedAllEnemyBases = (
  self: LightCycle,
  baseHp: Readonly<Record<string, number>>,
): boolean => {
  const need = baseHitsRequired(self.level);
  let aliveEnemyBases = 0;
  for (const base of TEAM_BASES) {
    if (base.name === self.colorName || (baseHp[base.name] ?? 0) <= 0) continue;
    aliveEnemyBases += 1;
    if ((self.baseHits[base.name] ?? 0) < need) return false;
  }
  return aliveEnemyBases > 0;
};
