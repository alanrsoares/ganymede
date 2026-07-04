// Pure generative composition: turns automaton observations into a musical
// state with three layers — beat, harmony, melody. No audio here; `audio.ts`
// synthesizes the returned MusicState. Deterministic given (observations,
// params), so it is unit-testable. The GoL substrate is the source of timing
// (step = generation / STEP_GENS) and expression (population, glider activity,
// and the inhibit gate's output steer harmony, register, and beat intensity).

/** Scales as semitone offsets from the root; degrees wrap up by octaves. */
const SCALES = {
  "minor pentatonic": [0, 3, 5, 7, 10],
  "major pentatonic": [0, 2, 4, 7, 9],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  "whole tone": [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
} as const satisfies Record<string, readonly number[]>;

export type ScaleName = keyof typeof SCALES;
export const SCALE_NAMES = Object.keys(SCALES) as ScaleName[];

/** How many generations advance one 16th-note step. */
export const STEP_GENS = 8;

const STEPS_PER_BAR = 16;
/** Chord roots as scale-degree indices, one per bar (a 4-bar loop). */
const PROGRESSION = [0, 3, 4, 2] as const;
/** Which 16th steps the lead plays on (1 = note). */
const LEAD_PATTERN = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0] as const;
/** Lead melodic contour as scale-degree offsets, off the downbeat. */
const LEAD_CONTOUR = [0, 2, 1, 3, 4, 2, 3, 5] as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const noteHz = (root: number, semitones: number) =>
  root * 2 ** (semitones / 12);

/** Semitone value of a scale degree index, wrapping across octaves. */
const degree = (scale: readonly number[], i: number): number => {
  const n = scale.length;
  const oct = Math.floor(i / n);
  return scale[((i % n) + n) % n] + 12 * oct;
};

export interface CaObservations {
  /** Normalized live-cell population, 0..1. */
  population: number;
  /** Normalized glider density in the lane detectors, 0..1. */
  activity: number;
  /** The inhibit gate's output (A AND NOT B). */
  gateHigh: boolean;
  /** Monotonic 16th-note step index (from generation / STEP_GENS). */
  step: number;
}

export interface MusicParams {
  root: number; // Hz
  scale: ScaleName;
}

export interface Voice {
  freq: number;
  gate: number; // 0..1
}

export interface MusicState {
  /** Beat layer: 0/1 triggers, held for the step. */
  kick: number;
  snare: number;
  hat: number;
  /** Harmony layer: held chord tones (Hz). */
  chord: number[];
  /** Melody layer. */
  lead: Voice;
}

/** Composes one step of the generative track from automaton observations. */
export const compose = (
  obs: CaObservations,
  params: MusicParams,
): MusicState => {
  const scale = SCALES[params.scale];
  const s = Math.max(0, Math.floor(obs.step));
  const inBar = s % STEPS_PER_BAR;
  const bar = Math.floor(s / STEPS_PER_BAR);
  const deg = PROGRESSION[bar % PROGRESSION.length];

  // Harmony: a diatonic triad an octave below the lead, moving once per bar.
  const chord = [deg, deg + 2, deg + 4].map(
    (i) => noteHz(params.root, degree(scale, i)) * 0.5,
  );

  // Beat: four-on-the-floor; the logic gate thins the kick when its output is
  // low, and dense glider activity fills in extra hats.
  const busy = obs.activity > 0.5;
  const kick = inBar % (obs.gateHigh ? 4 : 8) === 0 ? 1 : 0;
  const snare = inBar % 8 === 4 ? 1 : 0;
  const hat = inBar % 2 === 0 || busy ? 1 : 0;

  // Melody: chord tone on the downbeat, contour otherwise; population lifts the
  // register, and glider activity opens the line beyond its base pattern.
  const lift = Math.round(clamp01(obs.population) * scale.length);
  const onDownbeat = inBar % 4 === 0;
  const leadIdx =
    (onDownbeat ? deg + 2 : LEAD_CONTOUR[s % LEAD_CONTOUR.length]) +
    scale.length +
    lift;
  const lead: Voice = {
    freq: noteHz(params.root, degree(scale, leadIdx)),
    gate: LEAD_PATTERN[s % LEAD_PATTERN.length] === 1 || busy ? 1 : 0,
  };

  return { kick, snare, hat, chord, lead };
};
