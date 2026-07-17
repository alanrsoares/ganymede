// Hover inspector: a floating DOM card that surfaces the per-ship info the
// canvas can't show at a glance — the class archetype (vector badge + flavor),
// its live derived stats, its special traits, and where the ship sits on the
// L1→L5 evolution tree. Pure chrome: main.ts picks the ship under the cursor
// and feeds it here; this module only renders.

import van from "vanjs-core";
import { clamp01 } from "~/engine/physics";
import { type LightCycle, MAX_LEVEL } from "~/world";
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
} from "~/world/factory";
import {
  ARCHETYPE_INFO,
  type ArchetypeInfo,
  PEAK,
  rgbCss,
  TIERS,
  type Tier,
} from "./shipInfo";

const { div, span } = van.tags;
const svg = van.tags("http://www.w3.org/2000/svg");

// --- Stat bars --------------------------------------------------------------
// A segmented telemetry gauge. `frac` (0..1) is relative to the strongest
// class on that axis, so the lit segments read as a comparison, not absolute.
// The chunky ticks give it a cockpit-instrument feel rather than a web bar.
const SEGMENTS = 7;
const meter = (label: string, frac: number, tint: string, value: string) => {
  const on = Math.round(clamp01(frac) * SEGMENTS);
  return div(
    { class: "flex items-center gap-2" },
    span(
      {
        class: "w-9 shrink-0 text-[9px] uppercase tracking-[0.12em] opacity-55",
      },
      label,
    ),
    div(
      { class: "flex flex-1 gap-[2px]" },
      ...Array.from({ length: SEGMENTS }, (_, i) =>
        div({
          class: "h-2 flex-1 rounded-[1px]",
          style:
            i < on
              ? `background:${tint};box-shadow:0 0 5px ${tint}80`
              : "background:rgba(255,255,255,0.07)",
        }),
      ),
    ),
    span(
      { class: "w-12 shrink-0 text-right text-[10px] tabular-nums opacity-75" },
      value,
    ),
  );
};

const buildStatBars = (ship: LightCycle, tint: string) => {
  const a = ship.archetype;
  const lvl = ship.level;
  const mod = ARCHETYPE_MODS[a];
  return div(
    { class: "flex flex-col gap-1" },
    meter("hull", mod.hp / PEAK.hp, tint, `${maxHpFor(a, lvl)}`),
    meter("spd", mod.speed / PEAK.speed, tint, cruiseFor(a, lvl).toFixed(2)),
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
        "flex items-center gap-1 rounded-sm border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] opacity-85",
    },
    span({ class: "text-[6px] opacity-50" }, "◆"),
    text,
  );

const buildTraits = (ship: LightCycle) => {
  const a = ship.archetype;
  const lvl = ship.level;
  const mines = minesFor(a, lvl);
  const at = (unlocked: boolean, label: string, level: number) =>
    unlocked ? label : `${label} @ L${level}`;
  // [predicate, label] pairs — filtered to what applies, so this reads as data
  // rather than a branch pile (keeps cognitive complexity in check).
  const candidates: readonly [boolean, string][] = [
    [mines > 0, `${mines} mines`],
    [mines === 0 && ARCHETYPE_MODS[a].mines, "mines @ L3"],
    [
      carriesMissiles(a),
      at(lvl >= MISSILE_MIN_LEVEL, "missiles", MISSILE_MIN_LEVEL),
    ],
    [carriesArc(a), at(lvl >= ARC_MIN_LEVEL, "chain arc", ARC_MIN_LEVEL)],
    [isCarrier(a), "refuels allies"],
    [isRecon(a), "shares raid intel"],
    [ship.maxShield > 0, `${ship.maxShield} shield`],
  ];
  const traits = candidates.filter(([on]) => on).map(([, label]) => label);
  if (traits.length === 0) traits.push("gun only");
  return div({ class: "flex flex-wrap gap-1" }, ...traits.map(chip));
};

// --- Rank track -------------------------------------------------------------
// A horizontal L1→L5 ladder: one pip per rank, connected by links that light
// up as far as the ship has climbed, current rank filled solid. Compact enough
// to sit at the foot of the hover card, with a one-line caption for the rank
// the ship is at (plus its class-gated unlock, when it applies here).
const rankPip = (t: Tier, level: number, tint: string) => {
  const here = t.level === level;
  const reached = t.level <= level;
  const style = here
    ? `border-color:${tint};background:${tint};color:#04070a`
    : reached
      ? `border-color:${tint};color:${tint}`
      : "border-color:rgba(255,255,255,0.2);color:rgba(255,255,255,0.35)";
  return span(
    {
      class:
        "grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[8px] font-bold tabular-nums",
      style,
    },
    String(t.level),
  );
};

const rankLink = (reached: boolean, tint: string) =>
  div({
    class: "h-[2px] flex-1",
    style: reached
      ? `background:${tint}99`
      : "background:rgba(255,255,255,0.12)",
  });

const buildRankTrack = (ship: LightCycle, tint: string) => {
  const cur = TIERS.find((t) => t.level === ship.level) ?? TIERS[0];
  const gated =
    cur.gated?.find((g) => g.archetype === ship.archetype)?.note ?? null;
  const track = TIERS.flatMap((t, i) =>
    i === 0
      ? [rankPip(t, ship.level, tint)]
      : [
          rankLink(ship.level > TIERS[i - 1].level, tint),
          rankPip(t, ship.level, tint),
        ],
  );
  return div(
    { class: "flex flex-col gap-1.5" },
    div(
      { class: "flex items-center justify-between" },
      span(
        { class: "text-[8px] uppercase tracking-[0.28em] opacity-45" },
        "rank",
      ),
      span(
        {
          class: "text-[9px] uppercase tracking-[0.1em]",
          style: `color:${tint}`,
        },
        cur.title,
      ),
    ),
    div({ class: "flex items-center" }, ...track),
    span(
      { class: "text-[9px] leading-snug opacity-55" },
      cur.note,
      gated ? span({ style: `color:${tint}` }, ` · ${gated}`) : null,
    ),
  );
};

// --- Badge ------------------------------------------------------------------
// The blueprint glyph inside a reticle box: four corner ticks framing a
// filled hull + lighter detail strokes, all in the team tint — the moment the
// targeting readout "boxes" the contact.
const corner = (edges: string, tint: string) =>
  span({ class: `absolute h-2 w-2 ${edges}`, style: `border-color:${tint}` });

const buildBadge = (ship: LightCycle, tint: string) => {
  const g = ARCHETYPE_INFO[ship.archetype].glyph;
  return div(
    {
      class:
        "relative grid h-12 w-12 shrink-0 place-items-center rounded bg-white/[0.03]",
    },
    corner("left-0 top-0 border-l border-t", tint),
    corner("right-0 top-0 border-r border-t", tint),
    corner("bottom-0 left-0 border-b border-l", tint),
    corner("bottom-0 right-0 border-b border-r", tint),
    svg.svg(
      {
        viewBox: "0 0 24 24",
        class: "h-8 w-8",
        fill: "none",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      },
      svg.path({
        d: g.hull,
        fill: `${tint}26`,
        stroke: tint,
        "stroke-width": "1.4",
      }),
      svg.path({
        d: g.detail,
        stroke: tint,
        "stroke-width": "1",
        opacity: "0.65",
      }),
    ),
  );
};

// A hairline divider that fades from the tint — a scanner sweep line at rest.
const hairline = (tint: string) =>
  div({
    class: "h-px",
    style: `background:linear-gradient(90deg,${tint}55,transparent)`,
  });

// One-shot scanline that sweeps down when a fresh contact is acquired. Keyed
// off body re-creation (see mount: body rebuilds only on a new ship id).
const scanline = (tint: string) =>
  div({
    class: "card-scan pointer-events-none absolute inset-x-0 top-0 h-px",
    style: `background:linear-gradient(90deg,transparent,${tint},transparent)`,
  });

// Small paragraph helper (blurb copy).
const p = (text: string) =>
  span({ class: "text-[10px] leading-snug opacity-75" }, text);

// --- Card body --------------------------------------------------------------
const buildHeader = (ship: LightCycle, info: ArchetypeInfo, tint: string) =>
  div(
    { class: "flex items-start gap-3" },
    buildBadge(ship, tint),
    div(
      { class: "flex min-w-0 flex-1 flex-col gap-0.5" },
      div(
        { class: "flex items-center justify-between gap-2" },
        span(
          {
            class: "text-[8px] font-semibold uppercase tracking-[0.3em]",
            style: `color:${tint}`,
          },
          "◈ contact",
        ),
        span(
          { class: "text-[9px] tabular-nums opacity-55" },
          `L${ship.level}/${MAX_LEVEL}`,
        ),
      ),
      span(
        {
          class:
            "truncate text-[14px] font-bold uppercase leading-tight tracking-[0.06em]",
          style: `color:${tint}`,
        },
        info.label,
      ),
      span(
        { class: "text-[9px] uppercase tracking-[0.14em] opacity-55" },
        info.tagline,
      ),
    ),
  );

const buildCardBody = (ship: LightCycle) => {
  const info = ARCHETYPE_INFO[ship.archetype];
  const tint = rgbCss(ship.color);
  return div(
    { class: "relative flex flex-col gap-2.5 overflow-hidden" },
    scanline(tint),
    buildHeader(ship, info, tint),
    div(
      {
        class:
          "flex items-center justify-between text-[8px] uppercase tracking-[0.2em] opacity-40",
      },
      span({}, ship.colorName),
      span({}, ship.archetype),
    ),
    hairline(tint),
    p(info.blurb),
    buildStatBars(ship, tint),
    buildTraits(ship),
    buildRankTrack(ship, tint),
  );
};

// --- Mount ------------------------------------------------------------------
export interface ShipCard {
  /** Show the card for `ship` anchored near screen point (px,py); null hides. */
  render(ship: LightCycle | null, px: number, py: number): void;
}

const CARD_W = 272; // px, for edge-flip math

export const mountShipCard = (): ShipCard => {
  // `target` drives the body; `pos` drives placement. Splitting them means the
  // body only rebuilds when the contact changes (not every cursor move), so the
  // acquire scanline plays once per target instead of strobing as you hover.
  const target = van.state<LightCycle | null>(null);
  const pos = van.state<{ px: number; py: number } | null>(null);

  const root = div(
    {
      class: () =>
        `pointer-events-none fixed z-50 w-[272px] origin-top rounded-lg border bg-[#050b0f]/92 p-3 font-mono text-[#cfeee2] backdrop-blur-[6px] transition-[opacity,transform] duration-150 ${target.val ? "scale-100 opacity-100" : "scale-[0.97] opacity-0"}`,
      style: () => {
        const s = pos.val;
        const t = target.val;
        if (!s || !t) return "left:-9999px;top:0";
        // Flip to the cursor's left near the right edge; clamp within viewport.
        const flip = s.px + 18 + CARD_W > window.innerWidth;
        const left = flip ? s.px - 18 - CARD_W : s.px + 18;
        const top = Math.max(8, Math.min(window.innerHeight - 360, s.py - 20));
        const edge = rgbCss(t.color, 0.35);
        return `left:${Math.max(8, left)}px;top:${top}px;border-color:${edge};box-shadow:0 8px 30px -8px ${rgbCss(t.color, 0.4)}`;
      },
    },
    () => (target.val ? buildCardBody(target.val) : div()),
  );

  van.add(document.body, root);

  return {
    render: (ship, px, py) => {
      pos.val = ship ? { px, py } : null;
      const cur = target.val;
      if (!ship) {
        if (cur) target.val = null;
      } else if (!cur || cur.id !== ship.id) {
        target.val = ship;
      }
    },
  };
};
