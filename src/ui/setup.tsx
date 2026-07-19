// Pre-game setup screen: a React overlay on the Astryx dialog chrome that
// produces a MatchConfig and hands it to `onStart`. Shown at boot and
// re-openable as "New Game" when a match ends. The render loop keeps running
// behind it (a blurred live preview), so this module only owns the menu chrome.

import { Grid } from "@astryxdesign/core/Grid";
import { Slider } from "@astryxdesign/core/Slider";
import { VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { useState } from "react";
import { MAX_TEAMS, type MatchConfig } from "~/world";
import { DEFAULT_CONFIG } from "~/world/tuning";
import {
  ChoiceCard,
  Cta,
  createDialogStore,
  DialogShell,
  type DialogStore,
  mountReactDialog,
  SectionHeading,
} from "./dialog";

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

// Every field of the config as reactive component state, shared by the
// sliders, the preset buttons, and `readConfig`.
interface Fields {
  teams: number;
  ships: number;
  tempo: number;
  reinforce: number;
  lengthSec: number;
  endless: boolean;
}

const fieldsFromConfig = (c: MatchConfig): Fields => ({
  teams: c.teams,
  ships: c.initialShips,
  tempo: c.tempo,
  reinforce: c.reinforceRate,
  lengthSec: Math.round(c.reinforceGens / SIM_NOMINAL_FPS),
  endless: c.format === "endless",
});

const readConfig = (f: Fields): MatchConfig => ({
  teams: f.teams,
  initialShips: f.ships,
  reinforceRate: f.reinforce,
  tempo: f.tempo,
  reinforceGens: f.lengthSec * SIM_NOMINAL_FPS,
  format: f.endless ? "endless" : "standard",
});

// A preset is "selected" when the live fields still match every value it sets —
// so clicking it highlights it, and nudging any slider afterward auto-deselects.
const matchesPreset = (f: Fields, c: MatchConfig): boolean =>
  f.teams === c.teams &&
  f.ships === c.initialShips &&
  f.tempo === c.tempo &&
  f.reinforce === c.reinforceRate &&
  f.lengthSec === Math.round(c.reinforceGens / SIM_NOMINAL_FPS) &&
  f.endless === (c.format === "endless");

// One numeric slider, bound to a single field via typed get/set — keeps the
// control list data-driven instead of five near-identical JSX blocks.
interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  get: (f: Fields) => number;
  set: (v: number) => Partial<Fields>;
}

const SLIDERS: readonly SliderSpec[] = [
  {
    label: "players",
    min: 2,
    max: MAX_TEAMS,
    step: 1,
    fmt: (v) => `${v} teams`,
    get: (f) => f.teams,
    set: (v) => ({ teams: v }),
  },
  {
    label: "ships",
    min: 2,
    max: 12,
    step: 1,
    fmt: (v) => `${v}`,
    get: (f) => f.ships,
    set: (v) => ({ ships: v }),
  },
  {
    label: "tempo",
    min: 10,
    max: 90,
    step: 1,
    fmt: (v) => `${v} gen/s`,
    get: (f) => f.tempo,
    set: (v) => ({ tempo: v }),
  },
  {
    label: "reinforce",
    min: 0,
    max: 10,
    step: 1,
    fmt: (v) => (v === 0 ? "off" : `${v}/rate`),
    get: (f) => f.reinforce,
    set: (v) => ({ reinforce: v }),
  },
  {
    label: "length",
    min: 15,
    max: 180,
    step: 5,
    fmt: (v) => `${v}s`,
    get: (f) => f.lengthSec,
    set: (v) => ({ lengthSec: v }),
  },
];

type Patch = (p: Partial<Fields>) => void;

const MatchControls = ({ fields, patch }: { fields: Fields; patch: Patch }) => (
  <VStack gap={3} className="mt-2">
    {SLIDERS.map((s) => (
      <Slider
        key={s.label}
        label={s.label}
        min={s.min}
        max={s.max}
        step={s.step}
        value={s.get(fields)}
        onChange={(v: number) => patch(s.set(v))}
        formatValue={s.fmt}
      />
    ))}
    <Switch
      label={
        fields.endless ? "endless — no winner" : "standard — last team wins"
      }
      value={fields.endless}
      onChange={(v) => patch({ endless: v })}
    />
  </VStack>
);

const PresetGrid = ({
  fields,
  onPick,
}: {
  fields: Fields;
  onPick: (c: MatchConfig) => void;
}) => (
  <Grid columns={2} gap={2}>
    {PRESETS.map((preset) => (
      <ChoiceCard
        key={preset.name}
        title={preset.name}
        blurb={preset.blurb}
        pressed={matchesPreset(fields, preset.config)}
        onClick={() => onPick(preset.config)}
      />
    ))}
  </Grid>
);

const SetupView = ({
  store,
  onStart,
  onClose,
}: {
  store: DialogStore;
  onStart: (config: MatchConfig) => void;
  onClose: () => void;
}) => {
  const [fields, setFields] = useState<Fields>(() =>
    fieldsFromConfig(DEFAULT_CONFIG),
  );
  const patch: Patch = (p) => setFields((f) => ({ ...f, ...p }));
  const start = () => {
    store.close();
    onStart(readConfig(fields));
  };
  const close = () => {
    store.close();
    onClose();
  };
  return (
    <DialogShell
      store={store}
      label="Match setup"
      title="Autobattle"
      subtitle="Pick a preset or tune the match, then launch."
      onClose={close}
    >
      <SectionHeading>presets</SectionHeading>
      <PresetGrid
        fields={fields}
        onPick={(c) => setFields(fieldsFromConfig(c))}
      />
      <SectionHeading>match</SectionHeading>
      <MatchControls fields={fields} patch={patch} />
      <Cta label="Launch match" onClick={start} />
    </DialogShell>
  );
};

export const mountSetup = (
  onStart: (config: MatchConfig) => void,
  opts: SetupOpts = {},
): Setup => {
  const store = createDialogStore(!opts.startHidden);
  mountReactDialog(
    <SetupView
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
