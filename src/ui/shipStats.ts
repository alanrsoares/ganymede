// Ship-stats read model: one place that answers "what does the HUD say about a
// ship of archetype A at rank N" — class flavor, the L1→L5 tier notes, the
// counter relations, and the derived stat rows + trait chips shared by the
// hover inspector (shipCard.ts) and the browsable codex (codex.ts). Pure data
// + pure helpers — no live World state, no DOM. Stats come from the same
// tuning derivations the sim spawns from, so the views can never drift.

import { ARCHETYPES, type Archetype, type Rgb } from "~/world";
import {
  ARC_MIN_LEVEL,
  ARCHETYPE_MODS,
  carriesArc,
  carriesMissiles,
  cruiseFor,
  fireCooldownFor,
  isCarrier,
  isRecon,
  MISSILE_MIN_LEVEL,
  maxFuelFor,
  maxHpFor,
  minesFor,
} from "~/world/tuning";

// --- Per-class flavor -------------------------------------------------------
// The schematic top-down hull glyph (nose up) is derived on demand from the
// catalog geometry — see hull/silhouette.ts `hullSilhouettePath`. Kept out of
// this data so the codex/hover badges can never drift from the real hulls.
export interface ArchetypeInfo {
  label: string; // display name
  tagline: string; // one-line role hook
  blurb: string; // longer archetypal description
}

export const ARCHETYPE_INFO: Record<Archetype, ArchetypeInfo> = {
  scout: {
    label: "Recon Dart",
    tagline: "fast · fragile · recon",
    blurb:
      "Thin-hulled sprinter. Fastest cruise of any class, smallest tank, no heavy ordnance. Shares its enemy-base raid progress with nearby allies, so the whole squad tracks the level-up goal.",
  },
  fighter: {
    label: "Line Fighter",
    tagline: "balanced · gunner · backbone",
    blurb:
      "The all-rounder. Tightest fire cadence of the base classes, average speed and hull. No gimmick — just reliable trigger time. The spine of a squad.",
  },
  heavy: {
    label: "Carrier",
    tagline: "tank · mines · refuels allies",
    blurb:
      "Slow armored hauler. 1.5× hull and a huge tank. Seeds proximity mines from L3, and tops up thirsty allies mid-flight. Anchors the push, feeds the fleet.",
  },
  interceptor: {
    label: "Interceptor",
    tagline: "nimble · seeking missiles",
    blurb:
      "Hit-and-run hunter. Above-average speed; from L4 it locks seeking missiles onto enemy aces. Orbits at gun range and peppers instead of ramming.",
  },
};

// --- Evolution tree ---------------------------------------------------------
// One row per rank. `note` is the universal unlock; `gated`, when present,
// only lights up for the matching archetype (the class weapon tree).
export interface Tier {
  level: number;
  title: string;
  note: string;
  // Class-gated unlocks at this rank (each lights up only for its archetype).
  // A list so one rank can gate several classes at once.
  gated?: readonly { archetype: Archetype; note: string }[];
}

export const TIERS: readonly Tier[] = [
  { level: 1, title: "Rookie", note: "brawls solo — no flock sense" },
  {
    level: 2,
    title: "Regular",
    note: "raid all bases + cross center → rank",
    gated: [{ archetype: "fighter", note: "chain-lightning arcs a cluster" }],
  },
  {
    level: 3,
    title: "Veteran",
    note: "squad focus-fire",
    gated: [
      { archetype: "heavy", note: "proximity mines online" },
      { archetype: "interceptor", note: "seeking missiles online" },
    ],
  },
  { level: 4, title: "Elite", note: "kites at standoff range" },
  { level: 5, title: "Ace", note: "peak coordination + cadence" },
];

// --- Counter relations ------------------------------------------------------
// The rock-paper-scissors web, derived once from the tuning table. With a
// clean 4-cycle every class has exactly one predator, so both maps stay total.
export const COUNTERS: Record<Archetype, Archetype> = ARCHETYPES.reduce(
  (acc, a) => {
    acc[a] = ARCHETYPE_MODS[a].counters;
    return acc;
  },
  {} as Record<Archetype, Archetype>,
);

export const COUNTERED_BY: Record<Archetype, Archetype> = ARCHETYPES.reduce(
  (acc, a) => {
    acc[ARCHETYPE_MODS[a].counters] = a;
    return acc;
  },
  {} as Record<Archetype, Archetype>,
);

// --- Derived stats ----------------------------------------------------------
// An `rgb` (0..1) triple → CSS `rgba()`, with optional alpha.
export const rgbCss = (c: Rgb, a = 1) =>
  `rgba(${c.map((v) => Math.round(v * 255)).join(",")},${a})`;

// Peak multiplier on each axis across all classes, so bars normalize to the
// strongest class on that axis (a comparison, not an absolute).
const PEAK = {
  speed: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => m.speed)),
  hp: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => m.hp)),
  fuel: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => m.fuel)),
  fire: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => 1 / m.fire)),
};

// One HUD gauge row: `norm` (0..1, relative to the strongest class on the
// axis) drives the meter fill; `text` is the sim-accurate formatted readout.
export interface StatRow {
  key: "hull" | "spd" | "fire" | "fuel";
  norm: number;
  text: string;
}

export interface ShipStats {
  rows: readonly StatRow[];
  traits: readonly string[];
}

/**
 * Everything the HUD says about a ship of archetype `a` at rank `lvl`. Both
 * ship views render these rows/chips verbatim; live per-ship extras (shield)
 * stay with the caller.
 */
export const statsFor = (a: Archetype, lvl: number): ShipStats => {
  const mod = ARCHETYPE_MODS[a];
  const mines = minesFor(a, lvl);
  const pct = (v: number) => Math.round(v * 100);
  const at = (unlocked: boolean, label: string, level: number) =>
    unlocked ? label : `${label} @ L${level}`;
  // [predicate, label] pairs — filtered to what applies, so this reads as data
  // rather than a branch pile (keeps cognitive complexity in check).
  const candidates: readonly [boolean, string][] = [
    [mines > 0, `${mines} mines`],
    [mines === 0 && mod.mines, "mines @ L3"],
    [
      carriesMissiles(a),
      at(lvl >= MISSILE_MIN_LEVEL, "missiles", MISSILE_MIN_LEVEL),
    ],
    [mod.rammer, "rams + base slam"],
    [carriesArc(a), at(lvl >= ARC_MIN_LEVEL, "chain arc", ARC_MIN_LEVEL)],
    [isCarrier(a), "refuels allies"],
    [isRecon(a), "shares raid intel"],
    [mod.meleeResist > 0, `${pct(mod.meleeResist)}% melee armor`],
    [mod.pierceArmor > 0, `${pct(mod.pierceArmor)}% pierce armor`],
  ];
  return {
    rows: [
      { key: "hull", norm: mod.hp / PEAK.hp, text: String(maxHpFor(a, lvl)) },
      {
        key: "spd",
        norm: mod.speed / PEAK.speed,
        text: cruiseFor(a, lvl).toFixed(2),
      },
      // Faster fire = shorter cooldown; inverted so a fuller bar means quicker.
      {
        key: "fire",
        norm: 1 / mod.fire / PEAK.fire,
        text: `${Math.round(fireCooldownFor(a, lvl))}g`,
      },
      {
        key: "fuel",
        norm: mod.fuel / PEAK.fuel,
        text: String(maxFuelFor(a, lvl)),
      },
    ],
    traits: candidates.filter(([on]) => on).map(([, label]) => label),
  };
};
