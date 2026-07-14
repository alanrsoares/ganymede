// Pre-game setup screen: a full-viewport VanJS overlay that produces a
// MatchConfig and hands it to `onStart`. Shown at boot and re-openable as
// "New Game" when a match ends. The render loop keeps running behind it (a
// blurred live preview), so this module only owns the menu chrome.

import van, { type State } from "vanjs-core";
import { focusFirst, trapTab } from "./a11y";
import { MAX_TEAMS, type MatchConfig } from "./world";
import { DEFAULT_CONFIG } from "./world/factory";

const { div, h1, h2, label, input, span, button, p } = van.tags;

const SIM_NOMINAL_FPS = 45; // gens/s used to show the match length in seconds.

// Visible keyboard focus against the dark panel (shared by the buttons here).
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3fd8ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b0f]";

export interface Setup {
  show: () => void;
  hide: () => void;
  isOpen: () => boolean;
}

// Named starting points that fill every field at once.
interface Preset {
  name: string;
  blurb: string;
  config: MatchConfig;
}

const PRESETS: readonly Preset[] = [
  {
    name: "Duel",
    blurb: "2 teams · short, punchy",
    config: {
      teams: 2,
      initialShips: 4,
      reinforceRate: 4,
      tempo: 52,
      reinforceGens: 30 * SIM_NOMINAL_FPS,
      format: "standard",
    },
  },
  {
    name: "Standard",
    blurb: "4 teams · the default",
    config: DEFAULT_CONFIG,
  },
  {
    name: "Chaos",
    blurb: "4 teams · swarms, fast",
    config: {
      teams: 4,
      initialShips: 10,
      reinforceRate: 8,
      tempo: 72,
      reinforceGens: 60 * SIM_NOMINAL_FPS,
      format: "standard",
    },
  },
  {
    name: "Sandbox",
    blurb: "4 teams · endless watch",
    config: {
      teams: 4,
      initialShips: 8,
      reinforceRate: 5,
      tempo: 45,
      reinforceGens: 60 * SIM_NOMINAL_FPS,
      format: "endless",
    },
  },
];

const CYAN = "#3fd8ff";

// A labelled slider bound to a numeric state, with a live readout.
const slider = (
  text: string,
  s: State<number>,
  min: number,
  max: number,
  step: number,
  fmt: (v: number) => string,
) =>
  div(
    { class: "grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1" },
    label({ class: "justify-self-end opacity-80" }, text),
    input({
      type: "range",
      min,
      max,
      step,
      value: () => String(s.val),
      class: `w-[180px] cursor-pointer rounded-full outline-none [touch-action:manipulation] ${FOCUS_RING}`,
      style: `accent-color:${CYAN}`,
      oninput: (e: Event) => {
        s.val = Number((e.target as HTMLInputElement).value);
      },
    }),
    span({ class: "min-w-[64px] text-right tabular-nums opacity-70" }, () =>
      fmt(s.val),
    ),
  );

const presetButton = (preset: Preset, apply: (c: MatchConfig) => void) =>
  button(
    {
      type: "button",
      class: `flex flex-col items-start rounded-lg border border-[#3fd8ff]/25 bg-[#3fd8ff]/[0.04] px-3 py-2 text-left transition-colors hover:border-[#3fd8ff]/60 hover:bg-[#3fd8ff]/10 ${FOCUS_RING}`,
      onclick: () => apply(preset.config),
    },
    span(
      { class: "text-[12px] font-semibold uppercase tracking-[0.1em]" },
      preset.name,
    ),
    span({ class: "text-[10px] opacity-55" }, preset.blurb),
  );

// Every field of the config as a reactive state, shared by the sliders, the
// preset buttons, and `currentConfig`.
interface Fields {
  teams: State<number>;
  ships: State<number>;
  tempo: State<number>;
  reinforce: State<number>;
  lengthSec: State<number>;
  endless: State<boolean>;
}

const makeFields = (): Fields => ({
  teams: van.state(DEFAULT_CONFIG.teams),
  ships: van.state(DEFAULT_CONFIG.initialShips),
  tempo: van.state(DEFAULT_CONFIG.tempo),
  reinforce: van.state(DEFAULT_CONFIG.reinforceRate),
  lengthSec: van.state(
    Math.round(DEFAULT_CONFIG.reinforceGens / SIM_NOMINAL_FPS),
  ),
  endless: van.state(DEFAULT_CONFIG.format === "endless"),
});

const applyConfig = (f: Fields, c: MatchConfig) => {
  f.teams.val = c.teams;
  f.ships.val = c.initialShips;
  f.tempo.val = c.tempo;
  f.reinforce.val = c.reinforceRate;
  f.lengthSec.val = Math.round(c.reinforceGens / SIM_NOMINAL_FPS);
  f.endless.val = c.format === "endless";
};

const readConfig = (f: Fields): MatchConfig => ({
  teams: f.teams.val,
  initialShips: f.ships.val,
  reinforceRate: f.reinforce.val,
  tempo: f.tempo.val,
  reinforceGens: f.lengthSec.val * SIM_NOMINAL_FPS,
  format: f.endless.val ? "endless" : "standard",
});

const heading = (text: string) =>
  h2(
    {
      class:
        "mt-4 mb-1.5 text-[9px] font-semibold uppercase tracking-[0.3em] text-[#7fc4b1]",
    },
    text,
  );

const formatToggle = (endless: State<boolean>) =>
  button(
    {
      type: "button",
      role: "switch",
      "aria-checked": () => String(endless.val),
      class: () =>
        `rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors ${FOCUS_RING} ${
          endless.val
            ? "border-[#3fd8ff] bg-[#3fd8ff] text-[#040a0e]"
            : "border-[#3fd8ff]/40 text-[#8fe6ff]"
        }`,
      onclick: () => {
        endless.val = !endless.val;
      },
    },
    () => (endless.val ? "endless — no winner" : "standard — last team wins"),
  );

const matchControls = (f: Fields) =>
  div(
    { class: "flex flex-col gap-2 text-[11px]" },
    slider("players", f.teams, 2, MAX_TEAMS, 1, (v) => `${v} teams`),
    slider("ships", f.ships, 2, 12, 1, (v) => `${v}`),
    slider("tempo", f.tempo, 10, 90, 1, (v) => `${v} gen/s`),
    slider("reinforce", f.reinforce, 0, 10, 1, (v) =>
      v === 0 ? "off" : `${v}/rate`,
    ),
    slider("length", f.lengthSec, 15, 180, 5, (v) => `${v}s`),
    div(
      { class: "grid grid-cols-[auto_1fr] items-center gap-x-3" },
      label({ class: "justify-self-end opacity-80" }, "format"),
      div({ class: "justify-self-start" }, formatToggle(f.endless)),
    ),
  );

const panel = (f: Fields, start: () => void) =>
  div(
    {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Match setup",
      class:
        "w-full max-w-[440px] max-h-[90dvh] overflow-y-auto overscroll-contain rounded-2xl border border-[#3fd8ff]/25 bg-[#050b0f]/90 p-5 shadow-[0_20px_60px_-20px_#000]",
    },
    h1(
      {
        class:
          "text-[18px] font-bold uppercase tracking-[0.14em] text-[#d3f5e9]",
      },
      "Autobattle",
    ),
    p(
      { class: "mt-0.5 text-[11px] opacity-55" },
      "Pick a preset or tune the match, then launch.",
    ),
    heading("presets"),
    div(
      { class: "grid grid-cols-2 gap-2" },
      ...PRESETS.map((preset) =>
        presetButton(preset, (c) => applyConfig(f, c)),
      ),
    ),
    heading("match"),
    matchControls(f),
    button(
      {
        type: "button",
        class: `mt-5 w-full cursor-pointer rounded-xl border border-[#3fd8ff]/50 bg-[#3fd8ff]/15 py-2.5 text-[13px] font-bold uppercase tracking-[0.16em] text-[#d3f5e9] transition-colors hover:bg-[#3fd8ff]/25 ${FOCUS_RING}`,
        onclick: start,
      },
      "Launch match",
    ),
  );

export const mountSetup = (
  onStart: (config: MatchConfig) => void,
  opts: { startHidden?: boolean } = {},
): Setup => {
  // When gated behind the welcome screen, start closed so the panel never shows
  // through the splash; the welcome reveals it on hand-off via `show()`.
  const open = van.state(!opts.startHidden);
  const fields = makeFields();
  const start = () => {
    open.val = false;
    onStart(readConfig(fields));
  };

  const panelEl = panel(fields, start);
  const root = div(
    {
      class: () =>
        `absolute inset-0 z-40 place-items-center bg-[#040a0e]/70 p-6 font-mono text-[#cfeee2] backdrop-blur-[6px] ${open.val ? "grid" : "hidden"}`,
      // Keep Tab within the setup dialog while it's up.
      onkeydown: (e: KeyboardEvent) => trapTab(root, e),
    },
    panelEl,
  );
  van.add(document.body, root);

  const show = () => {
    open.val = true;
    focusFirst(panelEl); // land focus on the first preset, not behind the modal
  };
  if (!opts.startHidden) show(); // boot straight into setup unless the welcome gates it

  return {
    show,
    hide: () => {
      open.val = false;
    },
    isOpen: () => open.val,
  };
};
