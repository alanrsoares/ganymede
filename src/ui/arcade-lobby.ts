// Arcade lobby: a streamlined pre-run screen that picks a ship archetype and
// launches a pilot-first wave-survival run. Sibling to setup.ts (autobattle);
// shares the same dark cyan/mint chrome. The high-score table lands in Phase 3.

import van, { type State } from "vanjs-core";
import {
  ARCHETYPES,
  type ArcadeDifficulty,
  type Archetype,
  type MatchConfig,
} from "~/world";
import { ARCADE_TIERS } from "~/world/factory";
import {
  choiceCard,
  ctaButton,
  dialogPanel,
  dialogRoot,
  focusDefault,
  sectionHeading,
} from "./dialog";

const { div } = van.tags;

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

export interface LobbyOpts {
  startHidden?: boolean;
  /** Called when the player dismisses the dialog (✕ / Escape / backdrop). */
  onClose?: () => void;
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

const DIFFICULTIES: readonly ArcadeDifficulty[] = [
  "easy",
  "normal",
  "hard",
  "endless",
];

const panel = (
  selected: State<Archetype>,
  difficulty: State<ArcadeDifficulty>,
  start: () => void,
  close: () => void,
) =>
  dialogPanel(
    {
      label: "Arcade lobby",
      title: "Arcade",
      subtitle: "Fly one ship. Survive escalating waves. Chase a high score.",
      onClose: close,
    },
    sectionHeading("choose your hull"),
    div(
      { class: "grid grid-cols-2 gap-2.5" },
      ...HULLS.map((hull) =>
        choiceCard({
          title: hull.title,
          blurb: hull.blurb,
          pressed: () => selected.val === hull.key,
          onclick: () => {
            selected.val = hull.key;
          },
        }),
      ),
    ),
    sectionHeading("difficulty"),
    div(
      { class: "grid grid-cols-2 gap-2.5" },
      ...DIFFICULTIES.map((key) =>
        choiceCard({
          title: ARCADE_TIERS[key].label,
          blurb: ARCADE_TIERS[key].blurb,
          pressed: () => difficulty.val === key,
          onclick: () => {
            difficulty.val = key;
          },
        }),
      ),
    ),
    ctaButton("Launch run", start),
  );

export const mountArcadeLobby = (
  onStart: (config: MatchConfig) => void,
  opts: LobbyOpts = {},
): Lobby => {
  const open = van.state(!opts.startHidden);
  const selected = van.state<Archetype>(ARCHETYPES[1]); // fighter — friendly default
  const difficulty = van.state<ArcadeDifficulty>("normal");
  const start = () => {
    open.val = false;
    onStart(buildArcadeConfig(selected.val, difficulty.val));
  };
  const close = () => {
    open.val = false;
    opts.onClose?.();
  };

  const panelEl = panel(selected, difficulty, start, close);
  const root = dialogRoot(open, panelEl, close);
  van.add(document.body, root);

  const show = () => {
    open.val = true;
    focusDefault(panelEl);
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
