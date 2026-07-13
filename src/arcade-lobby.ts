// Arcade lobby: a streamlined pre-run screen that picks a ship archetype and
// launches a pilot-first wave-survival run. Sibling to setup.ts (autobattle);
// shares the same dark cyan/mint chrome. The high-score table lands in Phase 3.

import van, { type State } from "vanjs-core";
import { focusFirst, trapTab } from "./a11y";
import {
  ARCHETYPES,
  type ArcadeDifficulty,
  type Archetype,
  type MatchConfig,
} from "./world";
import { ARCADE_TIERS } from "./world/factory";

const { div, h1, h2, span, button, p } = van.tags;

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3fd8ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b0f]";

// Arcade tempo runs a touch faster than the autobattle default — one ship, so
// the field can move quicker without becoming unreadable.
const ARCADE_TEMPO = 52;

/** The MatchConfig for a pilot run with the chosen hull + difficulty tier. */
export const buildArcadeConfig = (
  archetype: Archetype,
  difficulty: ArcadeDifficulty,
): MatchConfig => {
  const tier = ARCADE_TIERS[difficulty];
  return {
    teams: 3, // cyan (player) + orange + emerald; pink dormant
    initialShips: 0,
    reinforceRate: 0,
    tempo: ARCADE_TEMPO,
    reinforceGens: 0,
    format: "arcade",
    arcade: {
      playerRole: "pilot",
      difficulty,
      playerTeam: "cyan",
      playerArchetype: archetype,
      victory: { kind: "none" },
      defeat: { kind: "lives", count: tier.lives },
      waves: {
        intermissionMinGens: tier.intermissionGens,
        spawn: tier.spawn,
      },
      enemyTeams: ["orange", "emerald"],
    },
  };
};

export interface Lobby {
  show: () => void;
  hide: () => void;
  isOpen: () => boolean;
}

interface HullBlurb {
  readonly key: Archetype;
  readonly title: string;
  readonly blurb: string;
}

const HULLS: readonly HullBlurb[] = [
  { key: "scout", title: "Scout", blurb: "Fast · fragile skirmisher" },
  { key: "fighter", title: "Fighter", blurb: "Balanced · twin cannons" },
  { key: "heavy", title: "Heavy", blurb: "Armored · mines, big tank" },
  {
    key: "interceptor",
    title: "Interceptor",
    blurb: "Nimble · homing missiles",
  },
];

const hullCard = (hull: HullBlurb, selected: State<Archetype>) =>
  button(
    {
      type: "button",
      "aria-pressed": () => String(selected.val === hull.key),
      class: () =>
        "flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors " +
        FOCUS_RING +
        (selected.val === hull.key
          ? " border-[#3fd8ff] bg-[#3fd8ff]/15"
          : " border-[#3fd8ff]/25 bg-[#3fd8ff]/[0.04] hover:border-[#3fd8ff]/60 hover:bg-[#3fd8ff]/10"),
      onclick: () => {
        selected.val = hull.key;
      },
    },
    span(
      { class: "text-[12px] font-semibold uppercase tracking-[0.1em]" },
      hull.title,
    ),
    span({ class: "text-[10px] opacity-55" }, hull.blurb),
  );

const DIFFICULTIES: readonly ArcadeDifficulty[] = [
  "easy",
  "normal",
  "hard",
  "endless",
];

const diffCard = (key: ArcadeDifficulty, selected: State<ArcadeDifficulty>) => {
  const tier = ARCADE_TIERS[key];
  return button(
    {
      type: "button",
      "aria-pressed": () => String(selected.val === key),
      class: () =>
        "flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors " +
        FOCUS_RING +
        (selected.val === key
          ? " border-[#3fd8ff] bg-[#3fd8ff]/15"
          : " border-[#3fd8ff]/25 bg-[#3fd8ff]/[0.04] hover:border-[#3fd8ff]/60 hover:bg-[#3fd8ff]/10"),
      onclick: () => {
        selected.val = key;
      },
    },
    span(
      { class: "text-[12px] font-semibold uppercase tracking-[0.1em]" },
      tier.label,
    ),
    span({ class: "text-[10px] opacity-55" }, tier.blurb),
  );
};

const heading = (text: string) =>
  h2(
    {
      class:
        "mt-4 mb-1.5 text-[9px] font-semibold uppercase tracking-[0.3em] text-[#7fc4b1]",
    },
    text,
  );

const panel = (
  selected: State<Archetype>,
  difficulty: State<ArcadeDifficulty>,
  start: () => void,
) =>
  div(
    {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Arcade lobby",
      class:
        "w-full max-w-[440px] rounded-2xl border border-[#3fd8ff]/25 bg-[#050b0f]/90 p-5 shadow-[0_20px_60px_-20px_#000]",
    },
    h1(
      {
        class:
          "text-[18px] font-bold uppercase tracking-[0.14em] text-[#d3f5e9]",
      },
      "Arcade",
    ),
    p(
      { class: "mt-0.5 text-[11px] opacity-55" },
      "Fly one ship. Survive escalating waves. Chase a high score.",
    ),
    heading("choose your hull"),
    div(
      { class: "grid grid-cols-2 gap-2" },
      ...HULLS.map((hull) => hullCard(hull, selected)),
    ),
    heading("difficulty"),
    div(
      { class: "grid grid-cols-2 gap-2" },
      ...DIFFICULTIES.map((key) => diffCard(key, difficulty)),
    ),
    button(
      {
        type: "button",
        class: `mt-5 w-full cursor-pointer rounded-xl border border-[#3fd8ff]/50 bg-[#3fd8ff]/15 py-2.5 text-[13px] font-bold uppercase tracking-[0.16em] text-[#d3f5e9] transition-colors hover:bg-[#3fd8ff]/25 ${FOCUS_RING}`,
        onclick: start,
      },
      "Launch run",
    ),
  );

export const mountArcadeLobby = (
  onStart: (config: MatchConfig) => void,
  opts: { startHidden?: boolean } = {},
): Lobby => {
  const open = van.state(!opts.startHidden);
  const selected = van.state<Archetype>(ARCHETYPES[1]); // fighter — friendly default
  const difficulty = van.state<ArcadeDifficulty>("normal");
  const start = () => {
    open.val = false;
    onStart(buildArcadeConfig(selected.val, difficulty.val));
  };

  const panelEl = panel(selected, difficulty, start);
  const root = div(
    {
      class: () =>
        `absolute inset-0 z-40 place-items-center bg-[#040a0e]/70 p-6 font-mono text-[#cfeee2] backdrop-blur-[6px] ${open.val ? "grid" : "hidden"}`,
      onkeydown: (e: KeyboardEvent) => trapTab(root, e),
    },
    panelEl,
  );
  van.add(document.body, root);

  const show = () => {
    open.val = true;
    focusFirst(panelEl);
  };
  if (!opts.startHidden) show();

  return {
    show,
    hide: () => {
      open.val = false;
    },
    isOpen: () => open.val,
  };
};
