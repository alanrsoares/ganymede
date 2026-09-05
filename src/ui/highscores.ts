// Arcade high scores — the only run state that outlives the tab. One table per
// difficulty (the tiers set different enemy pressure, so their scores aren't
// comparable), best `TABLE_SIZE` runs each, ranked by points then wave.
//
// Storage is a `Kv` seam like the drydock store's: `bun test` has no
// `localStorage`, and a corrupt / foreign value must never break the lobby, so
// every read re-validates and falls back to an empty table.

import type { ArcadeDifficulty, Archetype, World } from "~/world";
import { ARCHETYPES } from "~/world";

export interface HighScore {
  readonly score: number; // points banked by the player team (SCORE_KILL each)
  readonly wave: number;
  readonly kills: number;
  readonly archetype: Archetype;
  readonly at: number; // epoch ms — display only
}

/** The slice of `localStorage` this module needs (see drydock/env.ts). */
export interface Kv {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const memoryKv = (): Kv => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
};

export const defaultKv: Kv =
  typeof localStorage === "undefined" ? memoryKv() : localStorage;

// Versioned: a future entry shape ships under `.v2` and simply starts empty
// rather than having to migrate anyone's board.
const KEY = "ganymede.arcade.scores.v1";

/** Runs kept per difficulty. */
export const TABLE_SIZE = 5;

export type ScoreTable = Partial<Record<ArcadeDifficulty, HighScore[]>>;

const isArchetype = (v: unknown): v is Archetype =>
  ARCHETYPES.includes(v as Archetype);

const num = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const parseEntry = (v: unknown): HighScore | null => {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  return num(e.score) &&
    num(e.wave) &&
    num(e.kills) &&
    num(e.at) &&
    isArchetype(e.archetype)
    ? {
        score: e.score,
        wave: e.wave,
        kills: e.kills,
        at: e.at,
        archetype: e.archetype,
      }
    : null;
};

// Higher points win; a tie goes to the deeper wave, then the older run (so a
// matching score doesn't demote the record it tied).
const better = (a: HighScore, b: HighScore): number =>
  b.score - a.score || b.wave - a.wave || a.at - b.at;

const parseTable = (raw: string | null): ScoreTable => {
  if (raw === null) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return {};
    const out: ScoreTable = {};
    for (const [key, list] of Object.entries(data)) {
      if (!Array.isArray(list)) continue;
      const entries = list.flatMap((e) => parseEntry(e) ?? []);
      if (entries.length > 0) {
        out[key as ArcadeDifficulty] = entries
          .sort(better)
          .slice(0, TABLE_SIZE);
      }
    }
    return out;
  } catch {
    return {};
  }
};

export const loadScores = (kv: Kv = defaultKv): ScoreTable =>
  parseTable(kv.getItem(KEY));

/** The stored runs for one difficulty, best first. */
export const topScores = (
  difficulty: ArcadeDifficulty,
  kv: Kv = defaultKv,
): readonly HighScore[] => loadScores(kv)[difficulty] ?? [];

/**
 * Bank a finished run. Returns its 0-based rank in the difficulty's table, or
 * `null` when it didn't make the cut (nothing is written in that case).
 */
export const recordScore = (
  difficulty: ArcadeDifficulty,
  entry: HighScore,
  kv: Kv = defaultKv,
): number | null => {
  const table = loadScores(kv);
  const next = [...(table[difficulty] ?? []), entry].sort(better);
  const rank = next.indexOf(entry);
  if (rank >= TABLE_SIZE) return null;
  table[difficulty] = next.slice(0, TABLE_SIZE);
  try {
    kv.setItem(KEY, JSON.stringify(table));
  } catch {
    // Private-mode / quota failure: the run still ranked, it just won't persist.
  }
  return rank;
};

/**
 * The finished run as a table entry. Arcade banks `SCORE_KILL` per kill onto
 * the player team's scoreboard already, so the run's points are just that
 * team's total. `null` unless this really is a finished arcade run.
 */
export const runScore = (
  world: World,
  now: number = Date.now(),
): { difficulty: ArcadeDifficulty; entry: HighScore } | null => {
  const arcade = world.arcade;
  const config = world.config.arcade;
  if (!arcade?.over || !config) return null;
  return {
    difficulty: config.difficulty,
    entry: {
      score: world.score[config.playerTeam] ?? 0,
      wave: arcade.wave,
      kills: arcade.kills,
      archetype: config.playerArchetype,
      at: now,
    },
  };
};
