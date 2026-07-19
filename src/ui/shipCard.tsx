// Hover inspector: a floating DOM card that surfaces the per-ship info the
// canvas can't show at a glance — the class archetype (vector badge + flavor),
// its live derived stats, its special traits, and where the ship sits on the
// L1→L5 evolution tree. Pure chrome: main.ts picks the ship under the cursor
// and feeds it here; this module only renders.

import type { CSSProperties, ReactNode } from "react";
import { Fragment } from "react";
import { createRoot } from "react-dom/client";
import { AstryxRoot } from "~/astryx";
import { clamp01 } from "~/engine/physics";
import { hullSilhouettePath } from "~/hull/silhouette";
import { type Signal, signal, useSignal } from "~/ui/signal";
import { type LightCycle, MAX_LEVEL } from "~/world";
import {
  ARCHETYPE_INFO,
  type ArchetypeInfo,
  rgbCss,
  statsFor,
  TIERS,
  type Tier,
} from "./shipStats";

// --- Stat bars --------------------------------------------------------------
// A segmented telemetry gauge. `frac` (0..1) is relative to the strongest
// class on that axis, so the lit segments read as a comparison, not absolute.
// The chunky ticks give it a cockpit-instrument feel rather than a web bar.
const SEGMENTS = 7;
const Meter = ({
  label,
  frac,
  tint,
  value,
}: {
  label: string;
  frac: number;
  tint: string;
  value: string;
}) => {
  const on = Math.round(clamp01(frac) * SEGMENTS);
  return (
    <div className="flex items-center gap-2">
      <span className="w-9 shrink-0 text-[9px] uppercase tracking-[0.12em] opacity-55">
        {label}
      </span>
      <div className="flex flex-1 gap-[2px]">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length meter, segment position is the identity
            key={i}
            className="h-2 flex-1 rounded-[1px]"
            style={
              i < on
                ? { background: tint, boxShadow: `0 0 5px ${tint}80` }
                : { background: "rgba(255,255,255,0.07)" }
            }
          />
        ))}
      </div>
      <span className="w-12 shrink-0 text-right text-[10px] tabular-nums opacity-75">
        {value}
      </span>
    </div>
  );
};

const StatBars = ({ ship, tint }: { ship: LightCycle; tint: string }) => (
  <div className="flex flex-col gap-1">
    {statsFor(ship.archetype, ship.level).rows.map((r) => (
      <Meter
        key={r.key}
        label={r.key}
        frac={r.norm}
        tint={tint}
        value={r.text}
      />
    ))}
  </div>
);

// --- Trait chips ------------------------------------------------------------
const Chip = ({ text }: { text: string }) => (
  <span className="flex items-center gap-1 rounded-sm border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] opacity-85">
    <span className="text-[6px] opacity-50">◆</span>
    {text}
  </span>
);

const Traits = ({ ship }: { ship: LightCycle }) => {
  // Class traits come from the read model; shield is live per-ship state.
  const traits = [...statsFor(ship.archetype, ship.level).traits];
  if (ship.maxShield > 0) traits.push(`${ship.maxShield} shield`);
  if (traits.length === 0) traits.push("gun only");
  return (
    <div className="flex flex-wrap gap-1">
      {traits.map((t) => (
        <Chip key={t} text={t} />
      ))}
    </div>
  );
};

// --- Rank track -------------------------------------------------------------
// A horizontal L1→L5 ladder: one pip per rank, connected by links that light
// up as far as the ship has climbed, current rank filled solid. Compact enough
// to sit at the foot of the hover card, with a one-line caption for the rank
// the ship is at (plus its class-gated unlock, when it applies here).
const RankPip = ({
  t,
  level,
  tint,
}: {
  t: Tier;
  level: number;
  tint: string;
}) => {
  const here = t.level === level;
  const reached = t.level <= level;
  const style: CSSProperties = here
    ? { borderColor: tint, background: tint, color: "#04070a" }
    : reached
      ? { borderColor: tint, color: tint }
      : {
          borderColor: "rgba(255,255,255,0.2)",
          color: "rgba(255,255,255,0.35)",
        };
  return (
    <span
      className="grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[8px] font-bold tabular-nums"
      style={style}
    >
      {t.level}
    </span>
  );
};

const RankLink = ({ reached, tint }: { reached: boolean; tint: string }) => (
  <div
    className="h-[2px] flex-1"
    style={
      reached
        ? { background: `${tint}99` }
        : { background: "rgba(255,255,255,0.12)" }
    }
  />
);

const RankTrack = ({ ship, tint }: { ship: LightCycle; tint: string }) => {
  const cur = TIERS.find((t) => t.level === ship.level) ?? TIERS[0];
  const gated =
    cur.gated?.find((g) => g.archetype === ship.archetype)?.note ?? null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[8px] uppercase tracking-[0.28em] opacity-45">
          rank
        </span>
        <span
          className="text-[9px] uppercase tracking-[0.1em]"
          style={{ color: tint }}
        >
          {cur.title}
        </span>
      </div>
      <div className="flex items-center">
        {TIERS.map((t, i) => (
          <Fragment key={t.level}>
            {i > 0 && (
              <RankLink reached={ship.level > TIERS[i - 1].level} tint={tint} />
            )}
            <RankPip t={t} level={ship.level} tint={tint} />
          </Fragment>
        ))}
      </div>
      <span className="text-[9px] leading-snug opacity-55">
        {cur.note}
        {gated && <span style={{ color: tint }}>{` · ${gated}`}</span>}
      </span>
    </div>
  );
};

// --- Badge ------------------------------------------------------------------
// blueprint glyph inside a reticle box: four corner ticks framing the
// hull silhouette (derived from the catalog geometry) in the team tint — a
// moment-targeting readout "boxing" the contact.
const CORNERS = [
  "left-0 top-0 border-l border-t",
  "right-0 top-0 border-r border-t",
  "bottom-0 left-0 border-b border-l",
  "bottom-0 right-0 border-b border-r",
];

const Badge = ({ ship, tint }: { ship: LightCycle; tint: string }) => {
  const hull = hullSilhouettePath(ship.archetype);
  return (
    <div className="relative grid h-12 w-12 shrink-0 place-items-center rounded bg-white/[0.03]">
      {CORNERS.map((edges) => (
        <span
          key={edges}
          className={`absolute h-2 w-2 ${edges}`}
          style={{ borderColor: tint }}
        />
      ))}
      <svg
        viewBox="0 0 24 24"
        className="h-8 w-8"
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d={hull} fill={`${tint}26`} stroke={tint} strokeWidth="1.4" />
      </svg>
    </div>
  );
};

// A hairline divider that fades from the class tint to transparent.
const Hairline = ({ tint }: { tint: string }) => (
  <div
    className="h-px"
    style={{ background: `linear-gradient(90deg,${tint}55,transparent)` }}
  />
);

// A one-shot "acquired target" scan flare across the top of the card — plays
// once per contact because CardBody is keyed by ship id (see mount below).
const Scanline = ({ tint }: { tint: string }) => (
  <div
    className="card-scan pointer-events-none absolute inset-x-0 top-0 h-px"
    style={{
      background: `linear-gradient(90deg,transparent,${tint},transparent)`,
    }}
  />
);

// --- Card body ---------------------------------------------------------------
const CardHeader = ({
  ship,
  info,
  tint,
}: {
  ship: LightCycle;
  info: ArchetypeInfo;
  tint: string;
}) => (
  <div className="flex items-start gap-3">
    <Badge ship={ship} tint={tint} />
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[8px] font-semibold uppercase tracking-[0.3em]"
          style={{ color: tint }}
        >
          ◈ contact
        </span>
        <span className="text-[9px] tabular-nums opacity-55">
          L{ship.level}/{MAX_LEVEL}
        </span>
      </div>
      <span
        className="truncate text-[14px] font-bold uppercase leading-tight tracking-[0.06em]"
        style={{ color: tint }}
      >
        {info.label}
      </span>
      <span className="text-[9px] uppercase tracking-[0.14em] opacity-55">
        {info.tagline}
      </span>
    </div>
  </div>
);

const CardBody = ({ ship }: { ship: LightCycle }) => {
  const info = ARCHETYPE_INFO[ship.archetype];
  const tint = rgbCss(ship.color);
  return (
    <div className="relative flex flex-col gap-2.5 overflow-hidden">
      <Scanline tint={tint} />
      <CardHeader ship={ship} info={info} tint={tint} />
      <div className="flex items-center justify-between text-[8px] uppercase tracking-[0.2em] opacity-40">
        <span>{ship.colorName}</span>
        <span>{ship.archetype}</span>
      </div>
      <Hairline tint={tint} />
      <span className="text-[10px] leading-snug opacity-75">{info.blurb}</span>
      <StatBars ship={ship} tint={tint} />
      <Traits ship={ship} />
      <RankTrack ship={ship} tint={tint} />
    </div>
  );
};

// --- Mount ------------------------------------------------------------------
export interface ShipCard {
  /** Show the card for `ship` anchored near screen point (px,py); null hides. */
  render(ship: LightCycle | null, px: number, py: number): void;
}

const CARD_W = 272; // px, for edge-flip math

const ShipCardView = ({
  target,
  pos,
}: {
  target: Signal<LightCycle | null>;
  pos: Signal<{ px: number; py: number } | null>;
}) => {
  const t = useSignal(target);
  const s = useSignal(pos);

  // Flip to the cursor's left near the right edge; clamp within viewport.
  const style: CSSProperties = (() => {
    if (!s || !t) return { left: -9999, top: 0 };
    const flip = s.px + 18 + CARD_W > window.innerWidth;
    const left = flip ? s.px - 18 - CARD_W : s.px + 18;
    const top = Math.max(8, Math.min(window.innerHeight - 360, s.py - 20));
    const edge = rgbCss(t.color, 0.35);
    return {
      left: Math.max(8, left),
      top,
      borderColor: edge,
      boxShadow: `0 8px 30px -8px ${rgbCss(t.color, 0.4)}`,
    };
  })();

  let body: ReactNode = <div />;
  if (t) body = <CardBody key={t.id} ship={t} />;

  return (
    <div
      className={`pointer-events-none fixed z-50 w-[272px] origin-top rounded-lg border bg-[#050b0f]/92 p-3 font-mono text-[#cfeee2] backdrop-blur-[6px] transition-[opacity,transform] duration-150 ${t ? "scale-100 opacity-100" : "scale-[0.97] opacity-0"}`}
      style={style}
    >
      {body}
    </div>
  );
};

export const mountShipCard = (): ShipCard => {
  // `target` drives the body; `pos` drives placement. Splitting them means the
  // body only rebuilds when the contact changes (not every cursor move), so the
  // acquire scanline plays once per target instead of strobing as you hover.
  const target = signal<LightCycle | null>(null);
  const pos = signal<{ px: number; py: number } | null>(null);

  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <AstryxRoot>
      <ShipCardView target={target} pos={pos} />
    </AstryxRoot>,
  );

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
