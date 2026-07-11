// Declarative chrome (HUD, control panel, scoreboard) built with VanJS, styled
// with Tailwind utilities. The canvas + render loop stay imperative in main.ts;
// this module only owns the reactive DOM around them. HUD lines are van states
// the loop writes each frame — van updates just the bound text node.

import van, { type State } from "vanjs-core";

const { div, h1, label, input, p, span, button } = van.tags;

export interface UiConfig {
  /** Teams for the scoreboard: display name + CSS color. */
  teams: readonly { name: string; css: string }[];
  onTempo: (v: number) => void; // sim generations per second
  onReinforce: (v: number) => void; // reinforcement spawn rate
}

/** Reactive handles the render loop writes into. */
export interface Ui {
  status: State<string>;
  score: State<Readonly<Record<string, number>>>;
  counts: State<Readonly<Record<string, number>>>; // living ships per team
  hpOn: State<boolean>;
  banner: State<string>; // center win/draw banner ("" = hidden)
  activeTeamCount: State<number>; // scoreboard shows only the first N teams
  showError: (message: string) => void;
}

const HUD_LIVE = "mt-1 text-[12px] text-[#a9e8d6]";
const CYAN = "#3fd8ff";

interface KnobRange {
  min: number;
  max: number;
  step: number;
  value: number;
}

// A labelled range with a live value readout.
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

// A labelled on/off switch sharing the knob grid (label | switch | status).
const toggle = (
  id: string,
  text: string,
  state: State<boolean>,
  accent: string,
) => [
  label(
    { for: id, class: "justify-self-end tracking-[0.04em] opacity-[0.85]" },
    text,
  ),
  button(
    {
      id,
      type: "button",
      role: "switch",
      "aria-checked": () => String(state.val),
      class: () =>
        `w-[128px] cursor-pointer rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] [touch-action:manipulation] transition-colors ${state.val ? "text-[#040a0e]" : "text-[#8fe6ff] opacity-70"}`,
      style: () =>
        state.val
          ? `background:${accent};border-color:${accent}`
          : `border-color:${accent}66`,
      onclick: () => {
        state.val = !state.val;
      },
    },
    () => (state.val ? "shown" : "hidden"),
  ),
  span({ class: "min-w-[54px] text-right tabular-nums opacity-70" }, () =>
    state.val ? "on" : "off",
  ),
];

// Score-gain feedback: a "+N" that pops on a team's row when it scores. The
// sim hands us a fresh score object each tick, so this derive fires per tick
// (not per frame); each bump self-clears after the pop animation.
const useScoreBump = (
  score: State<Readonly<Record<string, number>>>,
  teams: readonly { name: string }[],
): State<Readonly<Record<string, number>>> => {
  const bump = van.state<Readonly<Record<string, number>>>({});
  let prevScore: Record<string, number> = {};
  van.derive(() => {
    const s = score.val;
    const next = { ...bump.val };
    let changed = false;
    for (const t of teams) {
      const delta = (s[t.name] ?? 0) - (prevScore[t.name] ?? 0);
      if (delta > 0) {
        next[t.name] = delta;
        changed = true;
        setTimeout(() => {
          const b = { ...bump.val };
          delete b[t.name];
          bump.val = b;
        }, 1000);
      }
    }
    prevScore = { ...s };
    if (changed) bump.val = next;
  });
  return bump;
};

// The scorePop keyframe animation is shared by the scoreboard bump and the
// win/draw banner; inject it once as a global stylesheet rule.
const injectScorePopStyle = () => {
  const popStyle = document.createElement("style");
  popStyle.textContent =
    "@keyframes scorePop{0%{opacity:0;transform:translateY(4px) scale(.8)}15%{opacity:1;transform:translateY(0) scale(1.15)}100%{opacity:0;transform:translateY(-12px) scale(1)}}";
  document.head.appendChild(popStyle);
};

const buildHud = (status: State<string>) =>
  div(
    {
      class:
        "pointer-events-none absolute right-4 top-4 max-w-[430px] text-left font-mono [text-shadow:0_0_8px_#04070a]",
    },
    h1(
      {
        class:
          "text-[14px] font-semibold uppercase tracking-[0.08em] text-[#d3f5e9]",
      },
      "Autobattle",
    ),
    p({ class: HUD_LIVE }, () => status.val),
  );

const buildControls = (cfg: UiConfig, hpOn: State<boolean>) => {
  const controlsOpen = van.state(true);

  const controlsBody = div(
    {
      id: "controls-body",
      class: () =>
        `${controlsOpen.val ? "grid" : "hidden"} grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5`,
    },
    knob(
      "k-tempo",
      "tempo",
      { min: 10, max: 90, step: 1, value: 45 },
      cfg.onTempo,
      (v) => `${v} gen/s`,
      CYAN,
    ),
    knob(
      "k-reinforce",
      "reinforce",
      { min: 0, max: 10, step: 1, value: 3 },
      cfg.onReinforce,
      (v) => (v === 0 ? "off" : `${v}/rate`),
      CYAN,
    ),
    ...toggle("k-hp", "hp bars", hpOn, CYAN),
  );

  return div(
    {
      class:
        "absolute bottom-4 left-4 rounded-lg border border-[#3fd8ff]/25 bg-[#040a0e]/75 px-3.5 py-3 font-mono text-[11px] text-[#8fe6ff] [touch-action:manipulation] backdrop-blur-[4px]",
    },
    div(
      {
        class: () =>
          `flex items-center justify-between gap-3 ${controlsOpen.val ? "mb-2" : ""}`,
      },
      span(
        {
          class:
            "text-[10px] font-semibold uppercase tracking-[0.16em] text-[#d3f5e9]",
        },
        "controls",
      ),
      button(
        {
          type: "button",
          class:
            "cursor-pointer rounded border border-[#3fd8ff]/30 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[#8fe6ff] transition-colors hover:bg-[#3fd8ff]/10",
          "aria-expanded": () => String(controlsOpen.val),
          "aria-controls": "controls-body",
          onclick: () => {
            controlsOpen.val = !controlsOpen.val;
          },
        },
        () => (controlsOpen.val ? "▾" : "▸"),
      ),
    ),
    controlsBody,
  );
};

const buildErrorBox = (error: State<string>) =>
  div(
    {
      class: () =>
        `absolute inset-0 place-items-center p-6 text-center text-[14px] text-[#f0a0a0] ${
          error.val ? "grid" : "hidden"
        }`,
    },
    () => error.val,
  );

// A single scoreboard row: team dot + name + living-ship count, plus score
// (and a floating "+N" bump when it just scored).
const buildTeamRow = (
  t: { name: string; css: string },
  s: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
  c: Readonly<Record<string, number>>,
) => {
  const n = c[t.name] ?? 0;
  return div(
    { class: "flex items-center justify-between gap-4" },
    span(
      { class: "flex items-center gap-1.5" },
      span({
        class: "inline-block h-2 w-2 rounded-full",
        style: `background:${t.css};box-shadow:0 0 6px ${t.css}`,
      }),
      span(
        { class: "uppercase tracking-[0.12em]", style: `color:${t.css}` },
        t.name,
      ),
      span(
        {
          class: `tabular-nums text-[9px] ${n === 0 ? "text-[#f0a0a0] opacity-70" : "opacity-55"}`,
        },
        `×${n}`,
      ),
    ),
    span(
      { class: "flex items-center gap-1.5" },
      b[t.name]
        ? span(
            {
              class: "tabular-nums font-bold text-[#7fe6a2]",
              style:
                "animation:scorePop 1s ease-out forwards;text-shadow:0 0 6px #2c7d5f",
            },
            `+${b[t.name]}`,
          )
        : null,
      span(
        { class: "tabular-nums font-bold text-[#ffe08a]" },
        String(s[t.name] ?? 0),
      ),
    ),
  );
};

// Per-team scoreboard rows, sorted by score (leader on top), scoped to the
// active teams (first N — the match may run fewer than the full roster).
const buildTeamRows = (
  teams: readonly { name: string; css: string }[],
  score: State<Readonly<Record<string, number>>>,
  bump: State<Readonly<Record<string, number>>>,
  counts: State<Readonly<Record<string, number>>>,
  activeTeamCount: State<number>,
) => {
  const s = score.val;
  const b = bump.val;
  const c = counts.val;
  return teams
    .slice(0, activeTeamCount.val)
    .sort((a, b2) => (s[b2.name] ?? 0) - (s[a.name] ?? 0))
    .map((t) => buildTeamRow(t, s, b, c));
};

const buildScoreBox = (
  cfg: UiConfig,
  score: State<Readonly<Record<string, number>>>,
  bump: State<Readonly<Record<string, number>>>,
  counts: State<Readonly<Record<string, number>>>,
  activeTeamCount: State<number>,
) => {
  const scoreOpen = van.state(true);

  return div(
    {
      class:
        "absolute left-1/2 top-3 min-w-[190px] -translate-x-1/2 rounded-lg border border-[#3fd8ff]/20 bg-[#040a0e]/70 px-3 py-2 font-mono text-[11px] [text-shadow:0_0_8px_#04070a] backdrop-blur-[3px]",
    },
    div(
      {
        class: () =>
          `flex items-center justify-between gap-3 ${scoreOpen.val ? "mb-1" : ""}`,
      },
      span(
        {
          class:
            "text-[9px] font-semibold uppercase tracking-[0.32em] text-[#7fc4b1]",
        },
        "scoreboard",
      ),
      button(
        {
          type: "button",
          class:
            "cursor-pointer rounded border border-[#3fd8ff]/30 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[#8fe6ff] transition-colors hover:bg-[#3fd8ff]/10",
          "aria-expanded": () => String(scoreOpen.val),
          onclick: () => {
            scoreOpen.val = !scoreOpen.val;
          },
        },
        () => (scoreOpen.val ? "▾" : "▸"),
      ),
    ),
    () =>
      scoreOpen.val
        ? div(
            { class: "flex flex-col gap-0.5" },
            ...buildTeamRows(cfg.teams, score, bump, counts, activeTeamCount),
          )
        : div(),
  );
};

// Center win/draw banner, shown when `banner` is non-empty.
const buildBanner = (banner: State<string>) =>
  div(
    {
      class: () =>
        `pointer-events-none absolute inset-x-0 top-1/3 text-center font-mono ${
          banner.val ? "block" : "hidden"
        }`,
    },
    span(
      {
        class:
          "inline-block rounded-xl border border-[#3fd8ff]/40 bg-[#040a0e]/80 px-8 py-4 text-[28px] font-bold uppercase tracking-[0.2em] text-[#d3f5e9] [text-shadow:0_0_16px_#3fd8ff] backdrop-blur-[4px]",
        style: "animation:scorePop 0.5s ease-out",
      },
      () => banner.val,
    ),
  );

export const mountUi = (cfg: UiConfig): Ui => {
  const status = van.state("");
  const score = van.state<Readonly<Record<string, number>>>({});
  const error = van.state("");
  const hpOn = van.state(true);
  const banner = van.state("");
  const counts = van.state<Readonly<Record<string, number>>>({});
  const activeTeamCount = van.state(cfg.teams.length);

  const bump = useScoreBump(score, cfg.teams);
  injectScorePopStyle();

  const hud = buildHud(status);
  const controls = buildControls(cfg, hpOn);
  const errorBox = buildErrorBox(error);
  const scoreBox = buildScoreBox(cfg, score, bump, counts, activeTeamCount);
  const bannerBox = buildBanner(banner);

  van.add(document.body, hud, controls, scoreBox, bannerBox, errorBox);

  return {
    status,
    score,
    counts,
    hpOn,
    banner,
    activeTeamCount,
    showError: (message) => {
      error.val = message;
    },
  };
};
