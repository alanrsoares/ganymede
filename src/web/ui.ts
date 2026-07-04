// Declarative chrome (HUD, control panel, splash, labels) built with VanJS,
// styled with Tailwind utilities. The canvas + GoL/audio render loop stay
// imperative in main.ts; this module only owns the reactive DOM around them.
// HUD lines are van states the loop writes each frame — van updates just the
// bound text node, so 60fps writes stay cheap.

import van, { type State } from "vanjs-core";

const { div, h1, p, label, input, select, option, span, button } = van.tags;

/** A positioned text label; coords are grid cells for the substrate, or
 *  normalized 0..1 for the abstract spec row. */
export interface UiLabel {
  x: number;
  y: number;
  text: string;
}

export interface UiConfig {
  gridW: number;
  gridH: number;
  /** Abstract spec-circuit labels, normalized 0..1. */
  nodeLabels: readonly UiLabel[];
  /** Real GoL substrate labels, in grid cells. */
  substrateLabels: readonly UiLabel[];
  scales: readonly string[];
  defaultScale: string;
  /** First click/tap/key: unlock audio, then the splash fades out. */
  onStart: () => void;
  onScale: (scale: string) => void;
  onTempo: (v: number) => void;
  onRoot: (v: number) => void;
  onVolume: (v: number) => void;
  onBeat: (v: number) => void;
  onHarmony: (v: number) => void;
  onMelody: (v: number) => void;
}

/** Reactive handles the render loop writes into. */
export interface Ui {
  status: State<string>;
  substrate: State<string>;
  gate: State<string>;
  and: State<string>;
  showError: (message: string) => void;
}

const SHADOW = "[text-shadow:0_0_6px_#04070a]";
// HUD text tiers: live state reads bright, the legend reads faint.
const HUD_LIVE = "mt-1 text-[12px] text-[#a9e8d6]";
const HUD_LIVE_ERR = "mt-1 text-[12px] font-semibold text-[#ff8f8f]";
const HUD_LEGEND = "mt-1 text-[11px] leading-snug text-[#7aa89a]";

interface KnobRange {
  min: number;
  max: number;
  step: number;
  value: number;
}

// A labelled range with a live value readout. `format` renders the current
// value with its unit; `accent` tints the thumb + focus ring per control group.
const knob = (
  id: string,
  text: string,
  attrs: KnobRange,
  on: (v: number) => void,
  format: (v: number) => string,
  accent: string,
) => {
  const shown = van.state(format(attrs.value));
  return [
    label(
      { for: id, class: "justify-self-end tracking-[0.04em] opacity-[0.85]" },
      text,
    ),
    input({
      id,
      type: "range",
      min: attrs.min,
      max: attrs.max,
      step: attrs.step,
      value: attrs.value,
      "aria-valuetext": () => shown.val,
      class:
        "w-[128px] cursor-pointer rounded-full outline-none [touch-action:manipulation] [-webkit-tap-highlight-color:transparent] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#040a0e]",
      style: `accent-color:${accent};--tw-ring-color:${accent}`,
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        shown.val = format(v);
        on(v);
      },
    }),
    span(
      { class: "min-w-[54px] text-right tabular-nums opacity-70" },
      () => shown.val,
    ),
  ];
};

const CYAN = "#3fd8ff";
const AMBER = "#f0b84a";
const GREEN = "#4fd88a";
const pct = (v: number) => `${v}%`;

export const mountUi = (cfg: UiConfig): Ui => {
  const status = van.state("tick 0");
  const substrate = van.state("substrate: verifying gpu≡cpu…");
  const gate = van.state("inhibit gate: …");
  const and = van.state("AND gate: …");
  const error = van.state("");
  const splashHidden = van.state(false);
  const legendOpen = van.state(false);

  const labels = div(
    { class: "pointer-events-none absolute inset-0" },
    cfg.nodeLabels.map((l) =>
      div(
        {
          class: `absolute -translate-x-1/2 whitespace-nowrap text-[11px] text-[#7fc4b1] opacity-50 ${SHADOW}`,
          style: `left:${l.x * 100}%;top:calc(${l.y * 100}% + 26px)`,
        },
        l.text,
      ),
    ),
    cfg.substrateLabels.map((l) =>
      div(
        {
          class: `absolute -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-[#8fe6ff] ${SHADOW}`,
          style: `left:${(l.x / cfg.gridW) * 100}%;top:${(l.y / cfg.gridH) * 100}%`,
        },
        `◆ ${l.text}`,
      ),
    ),
  );

  // State tinted by content: green when a gate output flows, neutral when dark.
  const flowClass = (s: string) =>
    /→ out 1/.test(s)
      ? `${HUD_LIVE} text-[#6fe0a0]`
      : `${HUD_LIVE} text-[#8fb0a6]`;

  const legendLines = [
    "datapath: CLK gun → glider lane (arp taps) → two wired GoL logic gates",
    "amber windows: lane taps — a glider arrival plays an arp note (click drops one)",
    "◆ cyan labels: real GoL substrate — dim row: abstract spec circuit (not GoL)",
    "input register (bottom key row): z/x = inhibit A/B · c/v = AND A/B",
    "green/red windows: gate outputs — inhibit → bass, AND → pad, word transposes",
    '♪ audio (Elementary): the computer arranges the track, "m" mutes',
  ];

  const hud = div(
    {
      class:
        "pointer-events-none absolute right-4 top-4 max-w-[430px] text-left font-mono [text-shadow:0_0_8px_#04070a]",
    },
    h1(
      {
        class:
          "text-[14px] font-semibold uppercase tracking-[0.08em] text-[#d3f5e9]",
      },
      "GoL Computer",
    ),
    // Live state — announced to screen readers only when the text truly changes.
    p({ class: HUD_LIVE }, () => status.val),
    p(
      {
        class: () => (substrate.val.includes("✗") ? HUD_LIVE_ERR : HUD_LIVE),
        "aria-live": "polite",
      },
      () => substrate.val,
    ),
    p(
      { class: () => flowClass(gate.val), "aria-live": "polite" },
      () => gate.val,
    ),
    p(
      { class: () => flowClass(and.val), "aria-live": "polite" },
      () => and.val,
    ),
    button(
      {
        class:
          "pointer-events-auto mt-2 rounded border border-[#3fd8ff]/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-[#8fe6ff] outline-none [touch-action:manipulation] hover:bg-[#3fd8ff]/10 focus-visible:ring-2 focus-visible:ring-[#3fd8ff]",
        type: "button",
        "aria-expanded": () => String(legendOpen.val),
        "aria-controls": "hud-legend",
        onclick: () => {
          legendOpen.val = !legendOpen.val;
        },
      },
      () => (legendOpen.val ? "legend ▾" : "legend ▸"),
    ),
    div(
      { id: "hud-legend", class: () => (legendOpen.val ? "block" : "hidden") },
      legendLines.map((line) => p({ class: HUD_LEGEND }, line)),
    ),
  );

  const groupHeader = (text: string, accent: string) =>
    div(
      {
        class:
          "[grid-column:1/-1] mt-2 border-b border-white/5 pb-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] first:mt-0",
        style: `color:${accent}`,
      },
      text,
    );

  const controls = div(
    {
      class:
        "absolute bottom-4 left-4 grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5 rounded-lg border border-[#3fd8ff]/25 bg-[#040a0e]/75 px-3.5 py-3 font-mono text-[11px] text-[#8fe6ff] [touch-action:manipulation] backdrop-blur-[4px]",
    },
    div(
      {
        class:
          "[grid-column:1/-1] mb-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#d3f5e9]",
      },
      "sound",
    ),

    groupHeader("transport", CYAN),
    knob(
      "k-tempo",
      "tempo",
      { min: 10, max: 90, step: 1, value: 45 },
      cfg.onTempo,
      (v) => `${v} gen/s`,
      CYAN,
    ),

    groupHeader("tonality", AMBER),
    label(
      {
        for: "k-scale",
        class: "justify-self-end tracking-[0.04em] opacity-[0.85]",
      },
      "scale",
    ),
    select(
      {
        id: "k-scale",
        class:
          "[grid-column:2/-1] rounded border border-[#f0b84a]/40 bg-[#04141c] px-1 py-0.5 font-[inherit] text-[11px] text-[#8fe6ff] outline-none [touch-action:manipulation] focus-visible:ring-2 focus-visible:ring-[#f0b84a]",
        onchange: (e: Event) =>
          cfg.onScale((e.target as HTMLSelectElement).value),
      },
      cfg.scales.map((s) =>
        option({ value: s, selected: s === cfg.defaultScale }, s),
      ),
    ),
    knob(
      "k-root",
      "root",
      { min: 98, max: 392, step: 1, value: 220 },
      cfg.onRoot,
      (v) => `${v} Hz`,
      AMBER,
    ),

    groupHeader("mix", GREEN),
    knob(
      "k-vol",
      "volume",
      { min: 0, max: 100, step: 1, value: 50 },
      (v) => cfg.onVolume(v / 100),
      pct,
      GREEN,
    ),
    knob(
      "k-beat",
      "beat",
      { min: 0, max: 100, step: 1, value: 90 },
      (v) => cfg.onBeat(v / 100),
      pct,
      GREEN,
    ),
    knob(
      "k-harm",
      "harmony",
      { min: 0, max: 100, step: 1, value: 70 },
      (v) => cfg.onHarmony(v / 100),
      pct,
      GREEN,
    ),
    knob(
      "k-mel",
      "melody",
      { min: 0, max: 100, step: 1, value: 80 },
      (v) => cfg.onMelody(v / 100),
      pct,
      GREEN,
    ),
  );

  const start = () => {
    cfg.onStart();
    splashHidden.val = true;
  };
  window.addEventListener("keydown", start, { once: true });

  const splash = div(
    {
      class: () =>
        `absolute inset-0 z-10 grid cursor-pointer place-content-center justify-items-center gap-2.5 bg-[radial-gradient(circle_at_50%_42%,rgba(6,20,26,0.72),rgba(2,5,8,0.94))] text-center backdrop-blur-[3px] transition-opacity duration-[600ms] ${
          splashHidden.val ? "pointer-events-none opacity-0" : ""
        }`,
      onpointerdown: start,
    },
    h1(
      {
        class:
          "text-[22px] font-semibold uppercase tracking-[0.14em] text-[#d3f5e9]",
      },
      "GoL Computer",
    ),
    p(
      { class: "max-w-[30ch] text-[13px] leading-[1.5] text-[#6fa899]" },
      "Generative music from Conway's Game of Life — glider streams play the notes, a logic gate switches the drone.",
    ),
    div(
      {
        class:
          "mt-3 rounded-full border border-[#3fd8ff]/50 px-[22px] py-2.5 text-[13px] tracking-[0.08em] text-[#8fe6ff] animate-[glow_1.8s_ease-in-out_infinite]",
      },
      "▶ click or tap to start",
    ),
  );

  const errorBox = div(
    {
      class: () =>
        `absolute inset-0 place-items-center p-6 text-center text-[14px] text-[#f0a0a0] ${
          error.val ? "grid" : "hidden"
        }`,
    },
    () => error.val,
  );

  van.add(document.body, labels, hud, controls, splash, errorBox);

  return {
    status,
    substrate,
    gate,
    and,
    showError: (message) => {
      error.val = message;
    },
  };
};
