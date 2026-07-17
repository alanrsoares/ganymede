// Declarative chrome (HUD, control panel, scoreboard) built with VanJS, styled
// with Tailwind utilities. The canvas + render loop stay imperative in main.ts;
// this module only owns the reactive DOM around them. HUD lines are van states
// the loop writes each frame — van updates just the bound text node.

import van, { type State } from "vanjs-core";
import type { LightCycle } from "~/world";
import { carriesMissiles } from "~/world/factory";
import { ARCHETYPE_INFO, rgbCss } from "./shipInfo";

const { div, h1, label, input, p, span, button } = van.tags;
const svg = van.tags("http://www.w3.org/2000/svg");

// Sonic-Wings-style life stock: a row of little hull-silhouette icons in the
// pilot's colour, one per remaining life, with a "×N" overflow past MAX.
const MAX_LIFE_ICONS = 6;
// Fallback silhouette (a delta) when there's no pilot to read a hull from.
const FALLBACK_HULL = "M12 2 L21 21 L12 16.5 L3 21 Z";

const shipIcon = (color: string, hull: string) =>
  svg.svg(
    { width: "15", height: "15", viewBox: "0 0 24 24" },
    svg.path({
      d: hull,
      fill: color,
      style: `filter:drop-shadow(0 0 2px ${color})`,
    }),
  );

const livesStrip = (
  lives: State<number | null>,
  ship: State<LightCycle | null>,
) =>
  div(
    {
      class: () =>
        `mt-1.5 items-center gap-1 ${lives.val == null ? "hidden" : "flex"}`,
    },
    () => {
      const n = lives.val ?? 0;
      const color = ship.val ? rgbCss(ship.val.color) : "#3fd8ff";
      const hull = ship.val
        ? ARCHETYPE_INFO[ship.val.archetype].glyph.hull
        : FALLBACK_HULL;
      const icons = Array.from({ length: Math.min(n, MAX_LIFE_ICONS) }, () =>
        shipIcon(color, hull),
      );
      return div(
        { class: "flex items-center gap-1" },
        ...icons,
        n > MAX_LIFE_ICONS
          ? span(
              {
                class: "ml-0.5 text-[11px] font-semibold tabular-nums",
                style: `color:${color}`,
              },
              `×${n}`,
            )
          : null,
      );
    },
  );

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
  hudTitle: State<string>; // HUD heading — "Autobattle" / "Arcade"
  arcadeLives: State<number | null>; // life stock strip (null = not arcade)
  showError: (message: string) => void;
  controlledShip: State<LightCycle | null>;
  // Hide/show the persistent chrome (HUD, scoreboard, controls) — used to keep
  // the welcome splash clean. Errors stay visible regardless.
  setChromeHidden: (hidden: boolean) => void;
  // Hide the sim-tuning knobs (tempo/reinforce). In arcade these are fixed by
  // the wave phase, so the player doesn't get to tune them.
  setSimKnobsHidden: (hidden: boolean) => void;
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

const buildHud = (
  title: State<string>,
  status: State<string>,
  arcadeLives: State<number | null>,
  controlledShip: State<LightCycle | null>,
) =>
  div(
    {
      class:
        "hud-status pointer-events-none absolute right-4 top-4 max-w-[430px] text-left font-mono [text-shadow:0_0_8px_#04070a]",
    },
    h1(
      {
        class:
          "text-[14px] font-semibold uppercase tracking-[0.08em] text-[#d3f5e9]",
      },
      () => title.val,
    ),
    p({ class: HUD_LIVE }, () => status.val),
    livesStrip(arcadeLives, controlledShip),
  );

const GRID = "grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5";

const buildControls = (cfg: UiConfig, hpOn: State<boolean>) => {
  const controlsOpen = van.state(true);
  // Sim-tuning knobs (tempo/reinforce). Hidden in arcade — there the stage/wave
  // sets tempo and spawns, so the player never tunes them.
  const simKnobsHidden = van.state(false);

  const simKnobs = div(
    { class: () => `${simKnobsHidden.val ? "hidden" : GRID}` },
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
  );

  const controlsBody = div(
    {
      id: "controls-body",
      class: () => `${controlsOpen.val ? "flex flex-col gap-y-1.5" : "hidden"}`,
    },
    simKnobs,
    div({ class: GRID }, ...toggle("k-hp", "hp bars", hpOn, CYAN)),
  );

  const el = div(
    {
      class:
        "hud-controls absolute bottom-4 left-4 rounded-lg border border-[#3fd8ff]/25 bg-[#040a0e]/75 px-3.5 py-3 font-mono text-[11px] text-[#8fe6ff] [touch-action:manipulation] backdrop-blur-[4px]",
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
  return { el, simKnobsHidden };
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

type Team = { name: string; css: string };

// Team-tinted fill that grows with the team's share of the leader's score, so
// the row itself reads as a bar — relative standings without a separate gauge.
const rowFill = (css: string, frac: number) =>
  div({
    class: "pointer-events-none absolute inset-y-0 left-0 rounded",
    style: `width:${(frac * 100).toFixed(1)}%;background:linear-gradient(90deg,${css}33,${css}08)`,
  });

// Left cluster: rank · dot · name · living-ship count (count turns red at 0).
const rowLeft = (t: Team, rank: number, n: number, dead: boolean) =>
  span(
    { class: "relative flex items-center gap-1.5" },
    span(
      { class: "w-3 text-right text-[9px] tabular-nums opacity-40" },
      String(rank + 1),
    ),
    span({
      class: "inline-block h-2.5 w-2.5 rounded-full",
      style: `background:${t.css};box-shadow:0 0 6px ${t.css}`,
    }),
    span(
      { class: "uppercase tracking-[0.12em]", style: `color:${t.css}` },
      t.name,
    ),
    span(
      {
        class: `tabular-nums text-[9px] ${dead ? "text-[#ff8a8a] opacity-90" : "opacity-55"}`,
      },
      `×${n}`,
    ),
  );

// Right cluster: floating "+N" bump when a team just scored, plus the total
// (leader's total is brighter and larger).
const rowRight = (val: number, bump: number | undefined, leader: boolean) =>
  span(
    { class: "relative flex items-center gap-1.5" },
    bump
      ? span(
          {
            class: "tabular-nums font-bold text-[#7fe6a2]",
            style:
              "animation:scorePop 1s ease-out forwards;text-shadow:0 0 6px #2c7d5f",
          },
          `+${bump}`,
        )
      : null,
    span(
      {
        class: `tabular-nums font-bold ${leader ? "text-[13px] text-[#ffe9a6] [text-shadow:0_0_8px_#ffb83f66]" : "text-[#ffe08a]"}`,
      },
      String(val),
    ),
  );

// A single scoreboard row, doubling as a relative-score bar. Leader (rank 0
// with points) gets a colour edge accent; eliminated teams (0 ships) dim out.
const buildTeamRow = (
  t: Team,
  s: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
  c: Readonly<Record<string, number>>,
  rank: number,
  maxScore: number,
) => {
  const n = c[t.name] ?? 0;
  const val = s[t.name] ?? 0;
  const dead = n === 0;
  const leader = rank === 0 && val > 0;
  return div(
    {
      class: `relative flex items-center justify-between gap-3 overflow-hidden rounded px-1.5 py-1 ${dead ? "opacity-40" : ""}`,
      style: leader ? `box-shadow:inset 2px 0 0 ${t.css}` : "",
    },
    rowFill(t.css, maxScore > 0 ? val / maxScore : 0),
    rowLeft(t, rank, n, dead),
    rowRight(val, b[t.name], leader),
  );
};

// Per-team scoreboard rows, sorted by score (leader on top), scoped to the
// active teams (first N — the match may run fewer than the full roster).
const buildTeamRows = (
  teams: readonly Team[],
  score: State<Readonly<Record<string, number>>>,
  bump: State<Readonly<Record<string, number>>>,
  counts: State<Readonly<Record<string, number>>>,
  activeTeamCount: State<number>,
) => {
  const s = score.val;
  const b = bump.val;
  const c = counts.val;
  const ranked = teams
    .slice(0, activeTeamCount.val)
    .sort((a, b2) => (s[b2.name] ?? 0) - (s[a.name] ?? 0));
  const maxScore = ranked.reduce((m, t) => Math.max(m, s[t.name] ?? 0), 0);
  return ranked.map((t, i) => buildTeamRow(t, s, b, c, i, maxScore));
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
        "hud-score absolute left-1/2 top-3 min-w-[216px] -translate-x-1/2 rounded-lg border border-[#3fd8ff]/20 bg-[#040a0e]/70 px-2.5 py-2 font-mono text-[11px] [text-shadow:0_0_8px_#04070a] backdrop-blur-[3px]",
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
          "aria-label": "Toggle scoreboard",
          class:
            "cursor-pointer rounded border border-[#3fd8ff]/30 px-2 py-1 text-[10px] leading-none uppercase tracking-[0.1em] text-[#8fe6ff] transition-colors hover:bg-[#3fd8ff]/10 [touch-action:manipulation]",
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
            { class: "flex flex-col gap-1" },
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

const buildManualHeader = (s: LightCycle) => {
  const archetypeLabel = s.archetype.toUpperCase();
  const levelLabel = `L${s.level}`;
  return div(
    {
      class:
        "flex justify-between items-center border-b border-[#ffb83f]/20 pb-1",
    },
    span(
      { class: "font-bold text-[12px] uppercase text-[#ffc66d]" },
      `🎮 CONTROL: ${archetypeLabel} ${levelLabel}`,
    ),
  );
};

const buildManualStats = (s: LightCycle) => {
  const hpPercent = Math.round((s.hp / s.maxHp) * 100);
  const shieldPercent =
    s.maxShield > 0 ? Math.round((s.shield / s.maxShield) * 100) : 0;
  const fuelPercent = Math.round((s.fuel / s.maxFuel) * 100);
  const ammoMines = s.mines;
  return div(
    { class: "grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] opacity-90" },
    span({}, `HULL: ${s.hp.toFixed(1)}/${s.maxHp} (${hpPercent}%)`),
    span(
      {},
      `SHIELD: ${s.shield.toFixed(1)}/${s.maxShield} (${shieldPercent}%)`,
    ),
    span({}, `FUEL: ${Math.round(s.fuel)}/${s.maxFuel} (${fuelPercent}%)`),
    span({}, `MINES: ${ammoMines}/${s.maxMines}`),
  );
};

const buildActionRow = (key: string, label: string, status: string) =>
  div(
    { class: "flex justify-between items-center" },
    span({ class: "text-[#ffd866]" }, `[${key}] ${label}`),
    span({ class: "opacity-75" }, status),
  );

const buildManualActions = (s: LightCycle) => {
  const bulletStatus =
    s.fireCooldown <= 0 ? "Ready" : `Reloading (${Math.ceil(s.fireCooldown)}g)`;
  const mineStatus = s.mines > 0 ? `Ready (${s.mines})` : "No Ammo";
  const missileStatus =
    s.level >= 3 || carriesMissiles(s.archetype)
      ? s.fuel > 150
        ? "Ready (150 F)"
        : "Low Fuel"
      : "Requires L3";
  const boostStatus = s.fuel > 200 ? "Ready (200 F)" : "Low Fuel";
  const shieldStatus = s.fuel > 300 ? "Ready (300 F)" : "Low Fuel";
  const cloakStatus = s.fuel > 400 ? "Ready (400 F)" : "Low Fuel";
  const fieldStatus = s.fuel > 300 ? "Ready (300 F)" : "Low Fuel";

  return div(
    { class: "mt-1 flex flex-col gap-1 border-t border-[#ffb83f]/10 pt-1.5" },
    div(
      {
        class:
          "text-[9px] uppercase tracking-wider text-[#ffb83f]/60 font-semibold",
      },
      "quick actions",
    ),
    buildActionRow("Space", "Fire Blasters", bulletStatus),
    buildActionRow("2", "Drop Mine", mineStatus),
    buildActionRow("3", "Homing Missile", missileStatus),
    buildActionRow("4", "Nitro Boost", boostStatus),
    buildActionRow("5", "Shield Recharge", shieldStatus),
    buildActionRow("6", "Cloak Device", cloakStatus),
    buildActionRow("7", "Force Field", fieldStatus),
    div(
      { class: "text-[9px] italic opacity-60 text-center mt-1.5" },
      "WASD/ARROWS to move. Click empty space to exit.",
    ),
  );
};

// Manual control HUD panel shown when a ship is under player control.
const buildManualPanel = (controlledShip: State<LightCycle | null>) =>
  div(
    {
      class: () =>
        `hud-manual absolute bottom-4 right-4 rounded-lg border border-[#ffb83f]/20 bg-[#040a0e]/85 px-4 py-3 font-mono text-[11px] text-[#ffe08a] backdrop-blur-[4px] transition-opacity duration-200 ${controlledShip.val ? "opacity-100 block" : "opacity-0 hidden"}`,
      style:
        "width: 270px; box-shadow: 0 0 15px rgba(255, 184, 63, 0.15); pointer-events: none;",
    },
    () => {
      const s = controlledShip.val;
      return !s
        ? div()
        : div(
            { class: "flex flex-col gap-1.5" },
            buildManualHeader(s),
            buildManualStats(s),
            buildManualActions(s),
          );
    },
  );

const buildHelpRow = (keys: string, action: string) =>
  div(
    { class: "flex justify-between items-start gap-4 text-[10px]" },
    span({ class: "text-[#8fe6ff]/80 font-bold whitespace-nowrap" }, keys),
    span({ class: "text-[#d3f5e9]/70 text-right" }, action),
  );

const buildHelpSection = (
  title: string,
  rows: { keys: string; action: string }[],
) =>
  div(
    { class: "flex flex-col gap-1" },
    div(
      {
        class:
          "text-[9px] uppercase tracking-wider text-[#3fd8ff]/60 font-semibold border-b border-[#3fd8ff]/10 pb-0.5 mb-0.5",
      },
      title,
    ),
    ...rows.map((r) => buildHelpRow(r.keys, r.action)),
  );

const buildControlsInfoPanel = () => {
  const open = van.state(false);

  const body = div(
    {
      class: () =>
        `${open.val ? "flex" : "hidden"} flex-col gap-3 mt-2 border-t border-[#3fd8ff]/20 pt-2`,
      style: "width: 230px;",
    },
    buildHelpSection("Flight Controls", [
      { keys: "WASD / Arrows", action: "Steer Ship" },
      { keys: "Space", action: "Fire Blasters" },
      { keys: "1 - 7", action: "Quick Actions" },
    ]),
    buildHelpSection("General Hotkeys", [
      { keys: "C", action: "Toggle Codex" },
      { keys: "H", action: "Toggle HP Bars" },
      { keys: "Z / X", action: "Reinforcements" },
    ]),
    buildHelpSection("Mouse Actions", [
      { keys: "Click Ship", action: "Manual Control" },
      { keys: "Click Void", action: "Spawn / Exit" },
      { keys: "Shift+Click", action: "Rally Beacon" },
    ]),
  );

  return div(
    {
      class:
        "hud-guide absolute top-12 left-4 rounded-lg border border-[#3fd8ff]/20 bg-[#040a0e]/75 px-3 py-2 font-mono text-[11px] backdrop-blur-[4px]",
      style: "box-shadow: 0 0 15px rgba(63, 216, 255, 0.1); z-index: 10;",
    },
    div(
      { class: "flex items-center justify-between gap-4" },
      span(
        {
          class:
            "text-[10px] font-semibold uppercase tracking-[0.16em] text-[#d3f5e9]",
        },
        "⌨️ GUIDE",
      ),
      button(
        {
          type: "button",
          class:
            "cursor-pointer rounded border border-[#3fd8ff]/30 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[#8fe6ff] transition-colors hover:bg-[#3fd8ff]/10",
          onclick: () => {
            open.val = !open.val;
          },
        },
        () => (open.val ? "▾" : "▸"),
      ),
    ),
    body,
  );
};

export const mountUi = (cfg: UiConfig): Ui => {
  const status = van.state("");
  const score = van.state<Readonly<Record<string, number>>>({});
  const error = van.state("");
  const hpOn = van.state(true);
  const banner = van.state("");
  const counts = van.state<Readonly<Record<string, number>>>({});
  const activeTeamCount = van.state(cfg.teams.length);
  const hudTitle = van.state("Autobattle");
  const arcadeLives = van.state<number | null>(null);
  const controlledShip = van.state<LightCycle | null>(null);

  injectScorePopStyle();
  const bump = useScoreBump(score, cfg.teams);
  const controls = buildControls(cfg, hpOn);
  // Persistent chrome, back to front. The error box overlays but isn't chrome
  // (it shows regardless of the splash), so it's added separately.
  const chrome = [
    buildHud(hudTitle, status, arcadeLives, controlledShip),
    controls.el,
    buildScoreBox(cfg, score, bump, counts, activeTeamCount),
    buildBanner(banner),
    buildManualPanel(controlledShip),
    buildControlsInfoPanel(),
  ] as HTMLElement[];
  van.add(document.body, ...chrome, buildErrorBox(error));

  return {
    status,
    score,
    counts,
    hpOn,
    banner,
    activeTeamCount,
    hudTitle,
    arcadeLives,
    controlledShip,
    showError: (message) => {
      error.val = message;
    },
    setChromeHidden: (hidden) => {
      for (const el of chrome) el.style.display = hidden ? "none" : "";
    },
    setSimKnobsHidden: (hidden) => {
      controls.simKnobsHidden.val = hidden;
    },
  };
};
