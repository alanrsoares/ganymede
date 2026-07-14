// Ship Codex: a toggle-able full-screen reference for the four class
// archetypes. Unlike the hover inspector (shipCard.ts, which needs a live ship
// under the cursor), this browses all classes at once — comparative stat bars
// at a selectable rank, the rock-paper-scissors counter web, and the shared
// L1→L5 progression tree. Pure chrome: main.ts owns the toggle key; this module
// only renders and reacts to its own local state. Reuses the static flavor +
// scaling from shipInfo.ts so the two views never drift.

import van, { type State } from "vanjs-core";
import { focusFirst, trapTab } from "./a11y";
import { clamp01 } from "./engine/physics";
import { ARCHETYPE_INFO, PEAK, TIERS } from "./shipInfo";
import { ARCHETYPES, type Archetype, MAX_LEVEL } from "./world";
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
} from "./world/factory";

const { div, span, button } = van.tags;
const svg = van.tags("http://www.w3.org/2000/svg");

// Codex is team-neutral, so each class gets its own signature accent (the
// hover card tints by team color instead). Chosen to echo each role: green
// runner, cyan backbone, amber tank, pink hunter.
const CLASS_TINT: Record<Archetype, string> = {
  scout: "#7cff9e",
  fighter: "#3fd8ff",
  heavy: "#ffb545",
  interceptor: "#ff6fae",
};

// Reverse of the `counters` relation: who presses on this class. With a clean
// 4-cycle every class has exactly one predator, so this stays a total map.
const COUNTERED_BY = ARCHETYPES.reduce(
  (acc, a) => {
    acc[ARCHETYPE_MODS[a].counters] = a;
    return acc;
  },
  {} as Record<Archetype, Archetype>,
);

// --- Stat bars --------------------------------------------------------------
// Segmented telemetry gauge (matches the hover card): lit ticks are relative
// to the strongest class on that axis, so the row reads as a comparison.
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

const buildStatBars = (a: Archetype, lvl: number, tint: string) => {
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
        "rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] opacity-80",
    },
    text,
  );

const buildTraits = (a: Archetype, lvl: number) => {
  const mod = ARCHETYPE_MODS[a];
  const mines = minesFor(a, lvl);
  const pct = (v: number) => Math.round(v * 100);
  // [predicate, label] pairs — filtered to what applies, so this reads as data
  // rather than a branch pile (keeps cognitive complexity in check).
  const candidates: readonly [boolean, string][] = [
    [mines > 0, `${mines} mines`],
    [mines === 0 && mod.mines, "mines @ L3"],
    [
      carriesMissiles(a),
      lvl >= MISSILE_MIN_LEVEL
        ? "missiles"
        : `missiles @ L${MISSILE_MIN_LEVEL}`,
    ],
    [mod.rammer, "rams + base slam"],
    [
      carriesArc(a),
      lvl >= ARC_MIN_LEVEL ? "chain arc" : `chain arc @ L${ARC_MIN_LEVEL}`,
    ],
    [isCarrier(a), "refuels allies"],
    [isRecon(a), "shares raid intel"],
    [mod.meleeResist > 0, `${pct(mod.meleeResist)}% melee armor`],
    [mod.pierceArmor > 0, `${pct(mod.pierceArmor)}% pierce armor`],
  ];
  const traits = candidates.filter(([on]) => on).map(([, label]) => label);
  if (traits.length === 0) traits.push("gun only");
  return div({ class: "flex flex-wrap gap-1" }, ...traits.map(chip));
};

// --- Badge ------------------------------------------------------------------
const corner = (edges: string, tint: string) =>
  span({ class: `absolute h-2 w-2 ${edges}`, style: `border-color:${tint}` });

const buildBadge = (a: Archetype, tint: string) => {
  const g = ARCHETYPE_INFO[a].glyph;
  return div(
    {
      class:
        "relative grid h-11 w-11 shrink-0 place-items-center rounded bg-white/[0.03]",
    },
    corner("left-0 top-0 border-l border-t", tint),
    corner("right-0 top-0 border-r border-t", tint),
    corner("bottom-0 left-0 border-b border-l", tint),
    corner("bottom-0 right-0 border-b border-r", tint),
    svg.svg(
      {
        viewBox: "0 0 24 24",
        class: "h-7 w-7",
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

// --- Class card -------------------------------------------------------------
const matchupLine = (a: Archetype, tint: string) => {
  const beats = ARCHETYPE_MODS[a].counters;
  const loses = COUNTERED_BY[a];
  return div(
    { class: "flex flex-wrap gap-x-2 text-[9px] uppercase tracking-[0.08em]" },
    span(
      { class: "opacity-70" },
      "presses ",
      span({ style: `color:${CLASS_TINT[beats]}` }, beats),
    ),
    span(
      { class: "opacity-70" },
      "wary of ",
      span({ style: `color:${CLASS_TINT[loses]}` }, loses),
    ),
    span({ style: `color:${tint};opacity:0.55` }, a),
  );
};

const buildClassCard = (a: Archetype, lvl: number) => {
  const info = ARCHETYPE_INFO[a];
  const tint = CLASS_TINT[a];
  return div(
    {
      class:
        "flex flex-col gap-2 rounded-lg border bg-white/[0.02] p-3 text-[#cfeee2]",
      style: `border-color:${tint}44`,
    },
    div(
      { class: "flex items-center gap-2.5" },
      buildBadge(a, tint),
      div(
        { class: "flex min-w-0 flex-col" },
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
      ),
    ),
    matchupLine(a, tint),
    span({ class: "text-[10px] leading-snug opacity-75" }, info.blurb),
    buildStatBars(a, lvl, tint),
    buildTraits(a, lvl),
  );
};

// --- Counter web (rock-paper-scissors diagram) ------------------------------
// Nodes sit at the corners of a square in cycle order, so every `a → counters(a)`
// arrow runs the same way around the ring. Positions in a 240×188 viewBox.
const NODE_POS: Record<Archetype, readonly [number, number]> = {
  scout: [120, 26],
  interceptor: [214, 94],
  heavy: [120, 162],
  fighter: [26, 94],
};

// Shorten an arrow at both ends so it starts/stops at the node rim, not center.
const arrowSegment = (
  from: readonly [number, number],
  to: readonly [number, number],
) => {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const r = 22; // node radius + gap
  return {
    x1: x1 + ux * r,
    y1: y1 + uy * r,
    x2: x2 - ux * r,
    y2: y2 - uy * r,
  };
};

const counterArrow = (a: Archetype) => {
  const seg = arrowSegment(NODE_POS[a], NODE_POS[ARCHETYPE_MODS[a].counters]);
  return svg.line({
    x1: seg.x1,
    y1: seg.y1,
    x2: seg.x2,
    y2: seg.y2,
    stroke: `${CLASS_TINT[a]}cc`,
    "stroke-width": "1.6",
    "marker-end": "url(#codex-arrow)",
  });
};

const counterNode = (a: Archetype) => {
  const [cx, cy] = NODE_POS[a];
  const tint = CLASS_TINT[a];
  return svg.g(
    {},
    svg.circle({
      cx,
      cy,
      r: 15,
      fill: `${tint}22`,
      stroke: tint,
      "stroke-width": "1.4",
    }),
    svg.text(
      {
        x: cx,
        y: cy + 3,
        "text-anchor": "middle",
        fill: tint,
        "font-size": "8",
        "font-family": "ui-monospace,monospace",
        "font-weight": "700",
      },
      a.slice(0, 4).toUpperCase(),
    ),
  );
};

const buildCounterWeb = () =>
  div(
    { class: "flex flex-col items-center gap-1" },
    span(
      { class: "text-[8px] uppercase tracking-[0.28em] opacity-45" },
      "counter web",
    ),
    svg.svg(
      { viewBox: "0 0 240 188", class: "h-[188px] w-[240px]" },
      svg.defs(
        {},
        svg.marker(
          {
            id: "codex-arrow",
            viewBox: "0 0 10 10",
            refX: "8",
            refY: "5",
            markerWidth: "6",
            markerHeight: "6",
            orient: "auto-start-reverse",
          },
          svg.path({ d: "M0 0 L10 5 L0 10 z", fill: "#cfeee2aa" }),
        ),
      ),
      ...ARCHETYPES.map(counterArrow),
      ...ARCHETYPES.map(counterNode),
    ),
    span({ class: "text-[9px] opacity-55" }, "arrow → the class it presses"),
  );

// --- Progression tree -------------------------------------------------------
const tierRow = (t: (typeof TIERS)[number], lvl: number) => {
  const here = t.level === lvl;
  const reached = t.level <= lvl;
  return div(
    {
      class: `flex flex-wrap items-baseline gap-x-2 rounded px-1.5 py-[2px] ${here ? "bg-white/10" : ""}`,
    },
    span(
      {
        class: "w-4 shrink-0 text-center tabular-nums font-bold",
        style: reached ? "color:#8fe6ff" : "opacity:0.35",
      },
      here ? "▸" : String(t.level),
    ),
    span(
      {
        class: `w-14 shrink-0 text-[10px] font-semibold ${reached ? "" : "opacity-45"}`,
      },
      t.title,
    ),
    span({ class: "text-[9px] opacity-55" }, t.note),
    ...(t.gated ?? []).map((g) =>
      span(
        {
          class: "text-[9px] font-semibold",
          style: `color:${CLASS_TINT[g.archetype]}`,
        },
        `· ${g.archetype}: ${g.note}`,
      ),
    ),
  );
};

const buildProgression = (lvl: number) =>
  div(
    { class: "flex flex-col gap-0.5" },
    span(
      { class: "text-[8px] uppercase tracking-[0.28em] opacity-45" },
      "progression — every class shares this ladder",
    ),
    ...TIERS.map((t) => tierRow(t, lvl)),
  );

// Shared focus-ring for the codex's interactive chrome (matches the ui.ts
// controls), so keyboard focus is always visible against the dark panel.
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3fd8ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b0f]";

// --- Level selector ---------------------------------------------------------
const levelPills = (level: State<number>) =>
  div(
    { class: "flex items-center gap-1" },
    span(
      { class: "mr-1 text-[9px] uppercase tracking-[0.2em] opacity-50" },
      "rank",
    ),
    ...Array.from({ length: MAX_LEVEL }, (_, i) => i + 1).map((n) =>
      button(
        {
          type: "button",
          "aria-pressed": () => String(level.val === n),
          "aria-label": `Rank ${n}`,
          class: () =>
            `h-6 w-6 cursor-pointer rounded border text-[10px] font-bold tabular-nums transition-colors ${FOCUS_RING} ${
              level.val === n
                ? "border-[#3fd8ff] bg-[#3fd8ff] text-[#040a0e]"
                : "border-[#3fd8ff]/30 text-[#8fe6ff] hover:bg-[#3fd8ff]/10"
            }`,
          onclick: () => {
            level.val = n;
          },
        },
        `L${n}`,
      ),
    ),
  );

// --- Overlay chrome ---------------------------------------------------------
const buildHeader = (level: State<number>, onClose: () => void) =>
  div(
    { class: "flex flex-wrap items-center justify-between gap-3" },
    div(
      { class: "flex flex-col" },
      span(
        {
          class:
            "text-[15px] font-bold uppercase tracking-[0.12em] text-[#d3f5e9]",
        },
        "Ship Codex",
      ),
      span(
        { class: "text-[9px] uppercase tracking-[0.2em] opacity-50" },
        "4 classes · rock-paper-scissors · ←/→ cycles rank",
      ),
    ),
    div(
      { class: "flex items-center gap-3" },
      levelPills(level),
      button(
        {
          type: "button",
          "aria-label": "Close codex",
          class: `cursor-pointer rounded border border-[#3fd8ff]/30 px-2 py-0.5 text-[11px] uppercase tracking-[0.1em] text-[#8fe6ff] transition-colors hover:bg-[#3fd8ff]/10 ${FOCUS_RING}`,
          onclick: onClose,
        },
        "esc ✕",
      ),
    ),
  );

const buildPanel = (level: State<number>, onClose: () => void) =>
  div(
    {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Ship codex",
      class:
        "flex max-h-[90vh] w-[min(760px,92vw)] flex-col gap-4 overflow-auto rounded-xl border border-[#3fd8ff]/30 bg-[#050b0f]/95 p-5 font-mono text-[#cfeee2] shadow-[0_20px_60px_-12px_#000] backdrop-blur-[8px]",
      // Clicks inside the panel must not fall through to the scrim (closes).
      onclick: (e: Event) => e.stopPropagation(),
    },
    buildHeader(level, onClose),
    div(
      { class: "flex flex-col gap-4 md:flex-row md:items-start" },
      buildCounterWeb(),
      () =>
        div(
          { class: "grid flex-1 grid-cols-1 gap-2.5 sm:grid-cols-2" },
          ...ARCHETYPES.map((a) => buildClassCard(a, level.val)),
        ),
    ),
    () => buildProgression(level.val),
  );

// Always-visible opener, tucked in the free top-left corner (HUD is top-right,
// scoreboard top-center, controls bottom-left). Hidden while the codex is open.
const buildOpener = (
  open: State<boolean>,
  hidden: State<boolean>,
  onOpen: () => void,
) =>
  button(
    {
      type: "button",
      class: () =>
        `hud-codex-open fixed left-4 top-4 z-30 cursor-pointer rounded-lg border border-[#3fd8ff]/25 bg-[#040a0e]/75 px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8fe6ff] backdrop-blur-[4px] transition-colors hover:bg-[#3fd8ff]/10 ${FOCUS_RING} ${open.val || hidden.val ? "hidden" : "block"}`,
      onclick: onOpen,
    },
    "◈ Ships (C)",
  );

export interface Codex {
  toggle: () => void;
  hide: () => void;
  isOpen: () => boolean;
  // Hide the always-visible opener (and close the panel) — keeps the welcome
  // splash clean; revealed once the player launches.
  setChromeHidden: (hidden: boolean) => void;
}

export const mountCodex = (): Codex => {
  const open = van.state(false);
  const hidden = van.state(false);
  const level = van.state(3);

  const openCodex = () => {
    if (open.val) return;
    open.val = true;
    focusFirst(panelEl); // move focus into the dialog once it's laid out
  };
  const closeCodex = () => {
    if (!open.val) return;
    open.val = false;
    opener.focus(); // restore focus to the control that opened it
  };

  const opener = buildOpener(open, hidden, openCodex);
  const panelEl = buildPanel(level, closeCodex);

  // Keydown lives on the scrim (van-idiomatic element prop): it only fires
  // while focus is inside the open dialog, so no global listener or open-guard
  // is needed. Events bubble up from the panel's controls.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      trapTab(panelEl, e);
      return;
    }
    if (e.key === "Escape") closeCodex();
    else if (e.key === "ArrowLeft") level.val = Math.max(1, level.val - 1);
    else if (e.key === "ArrowRight")
      level.val = Math.min(MAX_LEVEL, level.val + 1);
    else return;
    e.preventDefault();
  };

  const scrim = div(
    {
      class: () =>
        `fixed inset-0 z-40 place-items-center bg-black/70 p-4 backdrop-blur-[2px] ${open.val ? "grid" : "hidden"}`,
      onclick: closeCodex,
      onkeydown: onKey,
    },
    panelEl,
  );

  van.add(document.body, opener, scrim);

  return {
    toggle: () => (open.val ? closeCodex() : openCodex()),
    hide: closeCodex,
    isOpen: () => open.val,
    setChromeHidden: (h: boolean) => {
      hidden.val = h;
      if (h) closeCodex();
    },
  };
};
