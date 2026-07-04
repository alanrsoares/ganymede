// Declarative chrome (HUD, control panel, splash, labels) built with VanJS,
// styled with Tailwind utilities. The canvas + GoL/audio render loop stay
// imperative in main.ts; this module only owns the reactive DOM around them.
// HUD lines are van states the loop writes each frame — van updates just the
// bound text node, so 60fps writes stay cheap.

import van, { type State } from "vanjs-core";

const { div, h1, p, label, input, select, option } = van.tags;

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
const HUD_P = "mt-1 text-[12px] text-[#6fa899]";

const knob = (
  id: string,
  text: string,
  attrs: { min: number; max: number; step: number; value: number },
  on: (v: number) => void,
) => [
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
    class: "w-[140px] accent-[#3fd8ff]",
    oninput: (e: Event) => on(Number((e.target as HTMLInputElement).value)),
  }),
];

export const mountUi = (cfg: UiConfig): Ui => {
  const status = van.state("tick 0");
  const substrate = van.state("substrate: verifying gpu≡cpu…");
  const gate = van.state("inhibit gate: …");
  const and = van.state("AND gate: …");
  const error = van.state("");
  const splashHidden = van.state(false);

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

  const hud = div(
    {
      class:
        "pointer-events-none absolute right-4 top-4 max-w-[420px] text-right [text-shadow:0_0_8px_#04070a]",
    },
    h1(
      {
        class:
          "text-[14px] font-semibold uppercase tracking-[0.08em] text-[#d3f5e9]",
      },
      "GoL Computer",
    ),
    p({ class: HUD_P }, () => status.val),
    p({ class: HUD_P }, () => substrate.val),
    p({ class: HUD_P }, () => gate.val),
    p({ class: HUD_P }, () => and.val),
    p(
      { class: HUD_P },
      "pulse ● presence  ○ absence — background: Gosper gun in Conway's GoL (GPU compute)",
    ),
    p(
      { class: HUD_P },
      "amber windows: pulse detectors on the glider lane — click anywhere to drop a glider",
    ),
    p(
      { class: HUD_P },
      "◆ cyan labels: real GoL substrate — dim row: abstract spec circuit (not GoL)",
    ),
    p(
      { class: HUD_P },
      "purple windows: routing outputs — reflector (90° turn) + duplicator (fan-out →2)",
    ),
    p(
      { class: HUD_P },
      'green/red window: physical AND gate (two wired GoL gates) — keys "c"/"d" set A/B',
    ),
    p(
      { class: HUD_P },
      '♪ generative audio (Elementary): lane crossings pluck pentatonic voices, A∧¬B gates a drone, "m" mutes',
    ),
  );

  const controls = div(
    {
      class:
        "absolute bottom-4 left-4 grid grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-1.5 rounded-lg border border-[#3fd8ff]/25 bg-[#040a0e]/70 px-3.5 py-3 text-[11px] text-[#8fe6ff] backdrop-blur-[4px]",
    },
    knob(
      "k-tempo",
      "tempo",
      { min: 10, max: 90, step: 1, value: 45 },
      cfg.onTempo,
    ),
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
          "rounded border border-[#3fd8ff]/35 bg-[#04141c] px-1 py-0.5 font-[inherit] text-[11px] text-[#8fe6ff]",
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
    ),
    knob("k-vol", "volume", { min: 0, max: 100, step: 1, value: 50 }, (v) =>
      cfg.onVolume(v / 100),
    ),
    knob("k-beat", "beat", { min: 0, max: 100, step: 1, value: 90 }, (v) =>
      cfg.onBeat(v / 100),
    ),
    knob("k-harm", "harmony", { min: 0, max: 100, step: 1, value: 70 }, (v) =>
      cfg.onHarmony(v / 100),
    ),
    knob("k-mel", "melody", { min: 0, max: 100, step: 1, value: 80 }, (v) =>
      cfg.onMelody(v / 100),
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
