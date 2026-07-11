// Hover inspector: a floating DOM card that surfaces the per-ship info the
// canvas can't show at a glance — the class archetype (vector badge + flavor),
// its live derived stats, its special traits, and where the ship sits on the
// L1→L5 evolution tree. Pure chrome: main.ts picks the ship under the cursor
// and feeds it here; this module only renders.

import van from "vanjs-core";
import { type Archetype, type LightCycle, MAX_LEVEL } from "./world";
import {
  ARCHETYPE_MODS,
  carriesMissiles,
  cruiseFor,
  fireCooldownFor,
  isCarrier,
  isRecon,
  maxFuelFor,
  maxHpFor,
  minesFor,
} from "./world/factory";

const { div, span } = van.tags;
const svg = van.tags("http://www.w3.org/2000/svg");

// --- Static per-class flavor -----------------------------------------------
interface ArchetypeInfo {
  label: string; // display name
  tagline: string; // one-line role hook
  blurb: string; // longer archetypal description
  badge: string; // SVG path drawing the hull silhouette (24×24 viewbox)
}

const ARCHETYPE_INFO: Record<Archetype, ArchetypeInfo> = {
  scout: {
    label: "Recon Dart",
    tagline: "fast · fragile · recon",
    blurb:
      "Thin-hulled sprinter. Fastest cruise of any class, smallest tank, no heavy ordnance. Shares its enemy-base raid progress with nearby allies, so the whole squad tracks the level-up goal.",
    badge: "M12 2 L18 20 L12 16 L6 20 Z",
  },
  fighter: {
    label: "Line Fighter",
    tagline: "balanced · gunner · backbone",
    blurb:
      "The all-rounder. Tightest fire cadence of the base classes, average speed and hull. No gimmick — just reliable trigger time. The spine of a squad.",
    badge: "M12 2 L20 18 L12 14 L4 18 Z M12 14 L12 22",
  },
  heavy: {
    label: "Carrier",
    tagline: "tank · mines · refuels allies",
    blurb:
      "Slow armored hauler. 1.5× hull and a huge tank. Seeds proximity mines from L3, and tops up thirsty allies mid-flight. Anchors the push, feeds the fleet.",
    badge: "M12 3 L19 8 L19 16 L12 21 L5 16 L5 8 Z",
  },
  interceptor: {
    label: "Interceptor",
    tagline: "nimble · seeking missiles",
    blurb:
      "Hit-and-run hunter. Above-average speed; from L4 it locks seeking missiles onto enemy aces. Orbits at gun range and peppers instead of ramming.",
    badge: "M12 2 L15 12 L22 20 L12 16 L2 20 L9 12 Z",
  },
};

// --- Evolution tree ---------------------------------------------------------
// One row per rank. `note` is the universal unlock; `gated`, when present,
// only lights up for the matching archetype (the class weapon tree).
interface Tier {
  level: number;
  title: string;
  note: string;
  gated?: { archetype: Archetype; note: string };
}

const TIERS: readonly Tier[] = [
  { level: 1, title: "Rookie", note: "brawls solo — no flock sense" },
  { level: 2, title: "Regular", note: "raid all bases + cross center → rank" },
  {
    level: 3,
    title: "Veteran",
    note: "squad focus-fire",
    gated: { archetype: "heavy", note: "proximity mines online" },
  },
  {
    level: 4,
    title: "Elite",
    note: "kites at standoff range",
    gated: { archetype: "interceptor", note: "seeking missiles online" },
  },
  { level: 5, title: "Ace", note: "peak coordination + cadence" },
];

// --- Stat bars --------------------------------------------------------------
// A 0..1 meter. Widths are relative to the strongest class on that axis so the
// bars read as a comparison, not an absolute.
const rgbCss = (c: LightCycle["color"], a = 1) =>
  `rgba(${c.map((v) => Math.round(v * 255)).join(",")},${a})`;

const meter = (label: string, frac: number, tint: string, value: string) =>
  div(
    { class: "flex items-center gap-2" },
    span({ class: "w-11 shrink-0 text-right opacity-60" }, label),
    div(
      { class: "h-1.5 flex-1 overflow-hidden rounded-full bg-white/10" },
      div({
        class: "h-full rounded-full",
        style: `width:${Math.max(4, Math.min(100, frac * 100))}%;background:${tint};box-shadow:0 0 6px ${tint}`,
      }),
    ),
    span({ class: "w-12 shrink-0 tabular-nums opacity-70" }, value),
  );

// Peak multiplier on each axis across all classes, so bars normalize sensibly.
const PEAK = {
  speed: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => m.speed)),
  hp: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => m.hp)),
  fuel: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => m.fuel)),
  fire: Math.max(...Object.values(ARCHETYPE_MODS).map((m) => 1 / m.fire)),
};

const buildStatBars = (ship: LightCycle, tint: string) => {
  const a = ship.archetype;
  const lvl = ship.level;
  const mod = ARCHETYPE_MODS[a];
  return div(
    { class: "flex flex-col gap-1" },
    meter("hull", mod.hp / PEAK.hp, tint, `${maxHpFor(a, lvl)} hp`),
    meter("speed", mod.speed / PEAK.speed, tint, cruiseFor(a, lvl).toFixed(2)),
    // Faster fire = shorter cooldown; invert so a fuller bar means quicker.
    meter(
      "fire",
      1 / mod.fire / PEAK.fire,
      tint,
      `${Math.round(fireCooldownFor(a, lvl))}g`,
    ),
    meter("fuel", mod.fuel / PEAK.fuel, tint, String(maxFuelFor(a, lvl))),
  );
};

// --- Trait chips ------------------------------------------------------------
const chip = (text: string) =>
  span(
    {
      class:
        "rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] opacity-80",
    },
    text,
  );

const buildTraits = (ship: LightCycle) => {
  const a = ship.archetype;
  const traits: string[] = [];
  const mines = minesFor(a, ship.level);
  if (mines > 0) traits.push(`${mines} mines`);
  else if (ARCHETYPE_MODS[a].mines) traits.push("mines @ L3");
  if (carriesMissiles(a))
    traits.push(ship.level >= 4 ? "missiles" : "missiles @ L4");
  if (isCarrier(a)) traits.push("refuels allies");
  if (isRecon(a)) traits.push("shares raid intel");
  if (ship.maxShield > 0) traits.push(`${ship.maxShield} shield`);
  if (traits.length === 0) traits.push("gun only");
  return div({ class: "flex flex-wrap gap-1" }, ...traits.map(chip));
};

// --- Evolution tree DOM -----------------------------------------------------
// A rank is one of three phases relative to the ship's current level. Keyed by
// Math.sign(level - t.level) + 1 → future | here | past (no branching).
type Phase = "future" | "here" | "past";
const PHASE = ["future", "here", "past"] as const;
const TITLE_OPACITY: Record<Phase, string> = {
  future: "opacity-45",
  here: "",
  past: "opacity-55",
};

// One rank row: dim if unreached, tinted if current/past, with the class-gated
// unlock appended in the team color when it applies to this ship's archetype.
const buildTierRow = (t: Tier, ship: LightCycle, tint: string) => {
  const phase: Phase = PHASE[Math.sign(ship.level - t.level) + 1];
  const here = phase === "here";
  const reached = phase !== "future";
  const gated = t.gated?.archetype === ship.archetype ? t.gated.note : null;
  return div(
    {
      class: `flex items-baseline gap-1.5 rounded px-1 py-[1px] ${here ? "bg-white/10" : ""}`,
      style: here ? `box-shadow:inset 0 0 0 1px ${tint}55` : "",
    },
    span(
      {
        class: "w-4 shrink-0 text-center tabular-nums font-bold",
        style: reached ? `color:${tint}` : "opacity:0.35",
      },
      here ? "▸" : String(t.level),
    ),
    span(
      { class: `text-[10px] font-semibold ${TITLE_OPACITY[phase]}` },
      t.title,
    ),
    span({ class: "text-[9px] opacity-55" }, gated ? `${t.note} · ` : t.note),
    gated
      ? span(
          { class: "text-[9px] font-semibold", style: `color:${tint}` },
          gated,
        )
      : null,
  );
};

const buildEvolution = (ship: LightCycle, tint: string) =>
  div(
    { class: "flex flex-col gap-0.5" },
    span(
      { class: "text-[8px] uppercase tracking-[0.28em] opacity-45" },
      "evolution",
    ),
    ...TIERS.map((t) => buildTierRow(t, ship, tint)),
  );

// --- Badge ------------------------------------------------------------------
const buildBadge = (ship: LightCycle, tint: string) =>
  svg.svg(
    {
      viewBox: "0 0 24 24",
      class: "h-9 w-9 shrink-0",
      fill: "none",
      stroke: tint,
      "stroke-width": "1.6",
      "stroke-linejoin": "round",
    },
    svg.path({
      d: ARCHETYPE_INFO[ship.archetype].badge,
      fill: `${tint}22`,
    }),
  );

// --- Card body --------------------------------------------------------------
const buildCardBody = (ship: LightCycle) => {
  const info = ARCHETYPE_INFO[ship.archetype];
  const tint = rgbCss(ship.color);
  return div(
    { class: "flex flex-col gap-2" },
    // Header: badge + name + team/level.
    div(
      { class: "flex items-center gap-2.5" },
      buildBadge(ship, tint),
      div(
        { class: "flex flex-col" },
        span(
          {
            class: "text-[13px] font-bold leading-tight",
            style: `color:${tint}`,
          },
          info.label,
        ),
        span(
          { class: "text-[9px] uppercase tracking-[0.1em] opacity-60" },
          info.tagline,
        ),
        span(
          { class: "text-[9px] opacity-50" },
          `${ship.colorName} · L${ship.level}/${MAX_LEVEL} · ${ship.archetype}`,
        ),
      ),
    ),
    p(info.blurb),
    buildStatBars(ship, tint),
    buildTraits(ship),
    buildEvolution(ship, tint),
  );
};

// Small paragraph helper (blurb copy).
const p = (text: string) =>
  span({ class: "text-[10px] leading-snug opacity-75" }, text);

// --- Mount ------------------------------------------------------------------
export interface ShipCard {
  /** Show the card for `ship` anchored near screen point (px,py); null hides. */
  render(ship: LightCycle | null, px: number, py: number): void;
}

const CARD_W = 268; // px, for edge-flip math

export const mountShipCard = (): ShipCard => {
  const sel = van.state<{
    ship: LightCycle;
    px: number;
    py: number;
  } | null>(null);

  const root = div(
    {
      class: () =>
        `pointer-events-none fixed z-50 w-[268px] rounded-lg border bg-[#050b0f]/92 p-3 font-mono text-[#cfeee2] backdrop-blur-[6px] transition-opacity duration-100 ${sel.val ? "opacity-100" : "opacity-0"}`,
      style: () => {
        const s = sel.val;
        if (!s) return "left:-9999px;top:0";
        // Flip to the cursor's left near the right edge; clamp within viewport.
        const flip = s.px + 18 + CARD_W > window.innerWidth;
        const left = flip ? s.px - 18 - CARD_W : s.px + 18;
        const top = Math.max(8, Math.min(window.innerHeight - 320, s.py - 20));
        const tint = rgbCss(s.ship.color, 0.35);
        return `left:${Math.max(8, left)}px;top:${top}px;border-color:${tint};box-shadow:0 8px 30px -8px ${rgbCss(s.ship.color, 0.4)}`;
      },
    },
    () => (sel.val ? buildCardBody(sel.val.ship) : div()),
  );

  van.add(document.body, root);

  return {
    render: (ship, px, py) => {
      sel.val = ship ? { ship, px, py } : null;
    },
  };
};
