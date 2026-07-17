// Pre-game setup screen: a full-viewport VanJS overlay that produces a
// MatchConfig and hands it to `onStart`. Shown at boot and re-openable as
// "New Game" when a match ends. The render loop keeps running behind it (a
// blurred live preview), so this module only owns the menu chrome.

import van, { type State } from "vanjs-core";
import { MAX_TEAMS, type MatchConfig } from "~/world";
import { DEFAULT_CONFIG } from "~/world/tuning";
import {
  choiceCard,
  ctaButton,
  dialogPanel,
  dialogRoot,
  FOCUS_RING,
  focusDefault,
  sectionHeading,
} from "./dialog";

const { div, label, input, span, button } = van.tags;

const SIM_NOMINAL_FPS = 45; // gens/s used to show the match length in seconds.

export interface Setup {
  show: () => void;
  hide: () => void;
  isOpen: () => boolean;
}

export interface SetupOpts {
  startHidden?: boolean;
  /** Called when the player dismisses the dialog (✕ / Escape / backdrop). */
  onClose?: () => void;
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
    label({ class: "justify-self-end text-muted" }, text),
    input({
      type: "range",
      min,
      max,
      step,
      value: () => String(s.val),
      class: `w-[180px] cursor-pointer rounded-full outline-none accent-signal [touch-action:manipulation] ${FOCUS_RING}`,
      oninput: (e: Event) => {
        s.val = Number((e.target as HTMLInputElement).value);
      },
    }),
    span({ class: "min-w-[64px] text-right tabular-nums text-ink/80" }, () =>
      fmt(s.val),
    ),
  );

// A preset is "selected" when the live fields still match every value it sets —
// so clicking it highlights it, and nudging any slider afterward auto-deselects.
const matchesPreset = (f: Fields, c: MatchConfig): boolean =>
  f.teams.val === c.teams &&
  f.ships.val === c.initialShips &&
  f.tempo.val === c.tempo &&
  f.reinforce.val === c.reinforceRate &&
  f.lengthSec.val === Math.round(c.reinforceGens / SIM_NOMINAL_FPS) &&
  f.endless.val === (c.format === "endless");

const presetButton = (preset: Preset, f: Fields) =>
  choiceCard({
    title: preset.name,
    blurb: preset.blurb,
    pressed: () => matchesPreset(f, preset.config),
    onclick: () => applyConfig(f, preset.config),
  });

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

const formatToggle = (endless: State<boolean>) =>
  button(
    {
      type: "button",
      role: "switch",
      "aria-checked": () => String(endless.val),
      class: () =>
        `rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors ${FOCUS_RING} ${
          endless.val
            ? "border-signal bg-signal text-surface"
            : "border-line-strong text-muted hover:border-signal/60 hover:text-ink"
        }`,
      onclick: () => {
        endless.val = !endless.val;
      },
    },
    () => (endless.val ? "endless — no winner" : "standard — last team wins"),
  );

const matchControls = (f: Fields) =>
  div(
    { class: "flex flex-col gap-2.5 text-[11px]" },
    slider("players", f.teams, 2, MAX_TEAMS, 1, (v) => `${v} teams`),
    slider("ships", f.ships, 2, 12, 1, (v) => `${v}`),
    slider("tempo", f.tempo, 10, 90, 1, (v) => `${v} gen/s`),
    slider("reinforce", f.reinforce, 0, 10, 1, (v) =>
      v === 0 ? "off" : `${v}/rate`,
    ),
    slider("length", f.lengthSec, 15, 180, 5, (v) => `${v}s`),
    div(
      { class: "grid grid-cols-[auto_1fr] items-center gap-x-3" },
      label({ class: "justify-self-end text-muted" }, "format"),
      div({ class: "justify-self-start" }, formatToggle(f.endless)),
    ),
  );

const panel = (f: Fields, start: () => void, close: () => void) =>
  dialogPanel(
    {
      label: "Match setup",
      title: "Autobattle",
      subtitle: "Pick a preset or tune the match, then launch.",
      onClose: close,
    },
    sectionHeading("presets"),
    div(
      { class: "grid grid-cols-2 gap-2.5" },
      ...PRESETS.map((preset) => presetButton(preset, f)),
    ),
    sectionHeading("match"),
    matchControls(f),
    ctaButton("Launch match", start),
  );

export const mountSetup = (
  onStart: (config: MatchConfig) => void,
  opts: SetupOpts = {},
): Setup => {
  // When gated behind the welcome screen, start closed so the panel never shows
  // through the splash; the welcome reveals it on hand-off via `show()`.
  const open = van.state(!opts.startHidden);
  const fields = makeFields();
  const start = () => {
    open.val = false;
    onStart(readConfig(fields));
  };
  const close = () => {
    open.val = false;
    opts.onClose?.();
  };

  const panelEl = panel(fields, start, close);
  const root = dialogRoot(open, panelEl, close);
  van.add(document.body, root);

  const show = () => {
    open.val = true;
    focusDefault(panelEl); // current selection, never the close button
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
