import { toroidalDist, wrap } from "../engine/physics";
import { BASE_MAX_HP, baseHitsRequired, DEFAULT_CONFIG } from "./tuning";
import { type LightCycle, type MatchConfig, TEAM_BASES, TEAMS } from "./types";

export { toroidalDist, wrap };

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
