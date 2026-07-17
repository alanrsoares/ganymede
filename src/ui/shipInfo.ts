// Static, ship-independent class reference data shared by the hover inspector
// (shipCard.ts) and the browsable codex (codex.ts). Pure data + tiny pure
// helpers — no live World state, no DOM. Keeping it here is the single source
// of truth for class flavor, the L1→L5 tier notes, and the stat-bar scaling.

import type { Archetype, Rgb } from "~/world";
import { ARCHETYPE_MODS } from "~/world/factory";

// --- Per-class flavor -------------------------------------------------------
// A glyph is a schematic top-down hull (nose up) in a 24×24 viewBox: `hull` is
// the filled silhouette, `detail` the lighter accent strokes (spine, wings,
// plating, tail) that give each class a blueprint read. Rendered by the badge
// builders in shipCard.ts and codex.ts.
export interface Glyph {
  hull: string; // filled silhouette path
  detail: string; // stroked accent lines (no fill)
}

export interface ArchetypeInfo {
  label: string; // display name
  tagline: string; // one-line role hook
  blurb: string; // longer archetypal description
  glyph: Glyph;
}

export const ARCHETYPE_INFO: Record<Archetype, ArchetypeInfo> = {
  scout: {
    label: "Recon Dart",
    tagline: "fast · fragile · recon",
    blurb:
      "Thin-hulled sprinter. Fastest cruise of any class, smallest tank, no heavy ordnance. Shares its enemy-base raid progress with nearby allies, so the whole squad tracks the level-up goal.",
    glyph: {
      hull: "M13.1 2.7 L13.9 3.4 L15.8 9.2 L18.8 11.1 L18.8 13.3 L21.5 15.6 L20.7 18.6 L17.7 19.0 L17.3 20.6 L16.2 21.3 L7.8 21.3 L6.7 20.6 L6.3 19.0 L3.3 18.6 L2.5 15.6 L5.2 13.3 L5.2 11.1 L8.2 9.2 L10.1 3.4 L10.9 2.7 Z",
      detail: "",
    },
  },
  fighter: {
    label: "Line Fighter",
    tagline: "balanced · gunner · backbone",
    blurb:
      "The all-rounder. Tightest fire cadence of the base classes, average speed and hull. No gimmick — just reliable trigger time. The spine of a squad.",
    glyph: {
      hull: "M12.7 4.1 L13.8 5.5 L14.1 7.2 L21.5 7.6 L21.5 10.1 L16.9 12.9 L13.1 13.9 L13.1 15.7 L15.5 16.8 L15.5 17.5 L14.5 18.5 L13.1 18.9 L12.4 19.9 L11.6 19.9 L10.9 18.9 L9.5 18.5 L8.5 17.5 L8.5 16.8 L10.9 15.7 L10.9 13.9 L7.1 12.9 L2.5 10.1 L2.5 7.6 L9.9 7.2 L10.2 5.5 L11.3 4.1 Z",
      detail: "",
    },
  },
  heavy: {
    label: "Carrier",
    tagline: "tank · mines · refuels allies",
    blurb:
      "Slow armored hauler. 1.5× hull and a huge tank. Seeds proximity mines from L3, and tops up thirsty allies mid-flight. Anchors the push, feeds the fleet.",
    glyph: {
      hull: "M12.7 4.3 L14.3 6.6 L16.6 7.2 L16.9 9.9 L20.8 10.5 L21.5 11.2 L21.2 13.1 L18.6 14.5 L18.6 15.4 L17.9 16.1 L15.6 16.4 L14.9 17.1 L14.9 18.1 L15.6 18.7 L14.9 19.7 L9.1 19.7 L8.4 18.7 L9.1 18.1 L9.1 17.1 L8.4 16.4 L6.1 16.1 L5.4 15.4 L5.4 14.5 L2.8 13.1 L2.5 11.2 L3.2 10.5 L7.1 9.9 L7.4 7.2 L9.7 6.6 L11.3 4.3 Z",
      detail: "",
    },
  },
  interceptor: {
    label: "Interceptor",
    tagline: "nimble · seeking missiles",
    blurb:
      "Hit-and-run hunter. Above-average speed; from L4 it locks seeking missiles onto enemy aces. Orbits at gun range and peppers instead of ramming.",
    glyph: {
      hull: "M13.2 2.5 L15.9 9.5 L18.2 10.6 L18.6 13.4 L21.3 15.7 L20.5 18.8 L17.4 19.2 L16.3 21.5 L7.7 21.5 L6.6 19.2 L3.5 18.8 L2.7 15.7 L5.4 13.4 L5.8 10.6 L8.1 9.5 L10.8 2.5 Z",
      detail: "",
    },
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

// --- Stat-bar scaling -------------------------------------------------------
// An `rgb` (0..1) triple → CSS `rgba()`, with optional alpha.
export const rgbCss = (c: Rgb, a = 1) =>
  `rgba(${c.map((v) => Math.round(v * 255)).join(",")},${a})`;

// Peak multiplier on each axis across all classes, so bars normalize to the
// strongest class on that axis (a comparison, not an absolute).
export const PEAK = {
  speed: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => m.speed)),
  hp: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => m.hp)),
  fuel: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => m.fuel)),
  fire: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => 1 / m.fire)),
};
