// Arcade lobby: a streamlined pre-run screen that picks a ship archetype and
// launches a pilot-first wave-survival run. Sibling to setup.tsx (autobattle);
// shares the same Astryx dialog chrome. Also shows the persisted best runs for
// the selected difficulty (see ui/highscores.ts).

import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useState } from "react";
import { hullSilhouettePath } from "~/hull/silhouette";
import {
  ARCHETYPES,
  type ArcadeDifficulty,
  type Archetype,
  type MatchConfig,
} from "~/world";
import { ARCADE_TIERS } from "~/world/tuning";
import {
  ChoiceCard,
  Cta,
  createDialogStore,
  DialogShell,
  type DialogStore,
  mountReactDialog,
  SectionHeading,
  useDialogOpen,
} from "./dialog";
import { type HighScore, topScores } from "./highscores";
import { CLASS_TINT } from "./shipStats";

// The hull's top-down silhouette in its class tint — the arcade picker's glyph.
const HullGlyph = ({ a }: { a: Archetype }) => (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 sm:h-7 sm:w-7 shrink-0"
    aria-hidden="true"
  >
    <path
      d={hullSilhouettePath(a)}
      fill={`${CLASS_TINT[a]}3a`}
      stroke={CLASS_TINT[a]}
      strokeWidth="1.4"
    />
  </svg>
);

// Arcade tempo runs a touch faster than the autobattle default — one ship, so
// the field can move quicker without becoming unreadable.
const ARCADE_TEMPO = 52;

/** Which shape of run the lobby launches. */
export type RunFormat = "arena" | "stage";

/**
 * The MatchConfig for a pilot run with the chosen hull + difficulty tier.
 * The arena run is the wave survival mode; the stage run is the scroller, which
 * has no wave director — its enemies come from the stage, so its difficulty is
 * authored rather than adaptive.
 */
export const buildRunConfig = (
  archetype: Archetype,
  difficulty: ArcadeDifficulty,
  shape: RunFormat = "arena",
): MatchConfig => {
  const tier = ARCADE_TIERS[difficulty];
  return {
    teams: 3, // cyan (player) + orange + emerald; pink dormant
    initialShips: 0,
    reinforceRate: 0,
    tempo: ARCADE_TEMPO,
    reinforceGens: 0,
    format: shape === "stage" ? "scroll" : "arcade",
    run: {
      playerRole: "pilot",
      difficulty,
      playerTeam: "cyan",
      playerArchetype: archetype,
      victory: { kind: "none" },
      defeat: { kind: "lives", count: tier.lives },
      ...(shape === "arena"
        ? {
            waves: {
              intermissionMinGens: tier.intermissionGens,
              spawn: tier.spawn,
            },
          }
        : {}),
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

const SHAPES: readonly {
  key: RunFormat;
  title: string;
  blurb: string;
}[] = [
  { key: "arena", title: "Arena", blurb: "All-range · rising waves" },
  { key: "stage", title: "Stage", blurb: "Scrolling run · fly forward" },
];

const HULLS: readonly HullBlurb[] = [
  { key: "scout", title: "Recon Dart", blurb: "Fastest · light armor" },
  {
    key: "fighter",
    title: "Line Fighter",
    blurb: "Balanced · rapid fire",
  },
  { key: "heavy", title: "Carrier", blurb: "Armored · mines · fuel support" },
  {
    key: "interceptor",
    title: "Interceptor",
    blurb: "Nimble · guided missiles",
  },
];

const DIFFICULTIES: readonly ArcadeDifficulty[] = [
  "easy",
  "normal",
  "hard",
  "endless",
];

// One banked run: rank, points, and the wave/kills it got there on, glyphed
// with the hull that flew it.
const ScoreRow = ({ rank, run }: { rank: number; run: HighScore }) => (
  <HStack gap={2} vAlign="center" className="min-w-0">
    <Text color="secondary" className="w-4 shrink-0 text-[10px]! tabular-nums">
      {rank + 1}
    </Text>
    <HullGlyph a={run.archetype} />
    <Text weight="bold" className="text-[11px]! tabular-nums">
      {run.score.toLocaleString()}
    </Text>
    <Text color="secondary" className="ml-auto text-[10px]! tabular-nums">
      wave {run.wave} · {run.kills} kills
    </Text>
  </HStack>
);

// Best runs for the selected tier. Absent until there is something to show —
// an empty board is just noise above the launch button.
const ScoreBoard = ({ runs }: { runs: readonly HighScore[] }) =>
  runs.length === 0 ? null : (
    <>
      <SectionHeading>best runs</SectionHeading>
      <VStack gap={1.5}>
        {runs.map((run, i) => (
          <ScoreRow key={`${run.at}-${run.score}`} rank={i} run={run} />
        ))}
      </VStack>
    </>
  );

const LobbyView = ({
  store,
  onStart,
  onClose,
}: {
  store: DialogStore;
  onStart: (config: MatchConfig) => void;
  onClose: () => void;
}) => {
  const [selected, setSelected] = useState<Archetype>(ARCHETYPES[1]); // fighter
  const [difficulty, setDifficulty] = useState<ArcadeDifficulty>("normal");
  const [shape, setShape] = useState<RunFormat>("arena");
  const [runs, setRuns] = useState<readonly HighScore[]>([]);
  // The board is re-read every time the lobby opens: the run that just ended
  // was banked by the loop between the two openings.
  const open = useDialogOpen(store);
  useEffect(() => {
    setRuns(open ? topScores(difficulty) : []);
  }, [open, difficulty]);
  const start = () => {
    store.close();
    onStart(buildRunConfig(selected, difficulty, shape));
  };
  const close = () => {
    store.close();
    onClose();
  };
  return (
    <DialogShell
      store={store}
      label="Arcade setup"
      title="Arcade"
      subtitle="Pilot one ship. Hold the arena against rising waves, or fly a stage."
      onClose={close}
    >
      <SectionHeading>flight plan</SectionHeading>
      <Grid columns={2} gap={2}>
        {SHAPES.map((s) => (
          <ChoiceCard
            key={s.key}
            title={s.title}
            blurb={s.blurb}
            pressed={shape === s.key}
            onClick={() => setShape(s.key)}
          />
        ))}
      </Grid>
      <SectionHeading>choose your hull</SectionHeading>
      <Grid columns={2} gap={2}>
        {HULLS.map((hull) => (
          <ChoiceCard
            key={hull.key}
            title={hull.title}
            blurb={hull.blurb}
            pressed={selected === hull.key}
            onClick={() => setSelected(hull.key)}
            tint={CLASS_TINT[hull.key]}
            icon={<HullGlyph a={hull.key} />}
          />
        ))}
      </Grid>
      <SectionHeading>difficulty</SectionHeading>
      <Grid columns={2} gap={2}>
        {DIFFICULTIES.map((key) => (
          <ChoiceCard
            key={key}
            title={ARCADE_TIERS[key].label}
            blurb={ARCADE_TIERS[key].blurb}
            pressed={difficulty === key}
            onClick={() => setDifficulty(key)}
          />
        ))}
      </Grid>
      {shape === "arena" ? <ScoreBoard runs={runs} /> : null}
      <Cta label="Start run" onClick={start} />
    </DialogShell>
  );
};

export const mountArcadeLobby = (
  onStart: (config: MatchConfig) => void,
  opts: LobbyOpts = {},
): Lobby => {
  const store = createDialogStore(!opts.startHidden);
  mountReactDialog(
    <LobbyView
      store={store}
      onStart={onStart}
      onClose={() => opts.onClose?.()}
    />,
  );
  return {
    show: () => store.open(),
    hide: () => store.close(),
    isOpen: () => store.isOpen(),
  };
};
