// Pure generative composition: turns automaton observations into a musical
// state with four layers — beat, sub-bass, harmony, arp. No audio here;
// `audio.ts` synthesizes the returned MusicState. Deterministic given
// (observations, params), so it is unit-testable.
//
// The connection is COMPUTATIONAL, not statistical: the two real GoL gate
// outputs (inhibit A∧¬B, wired AND A∧B) form a 2-bit word that transposes the
// harmony and enables layers — flipping the substrate's A/B/C/D inputs
// reprograms the arrangement. The melody is a physics-timed arpeggio: each lane
// tap fires a note when a glider actually arrives. Population + glider density
// are demoted to texture (filter cutoff only), since any CA yields those.

/** Scales as semitone offsets from the root; degrees wrap up by octaves. */
const SCALES = {
  "minor pentatonic": [0, 3, 5, 7, 10],
  "major pentatonic": [0, 2, 4, 7, 9],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
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
/** Syncopated bass groove (1 = note): downbeat plus pushed off-beats. */
const BASS_PATTERN = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0] as const;
/** Chord-tone offset per step for a walking root/fifth bass movement. */
const BASS_MOVE = [0, 0, 0, 4, 0, 0, 2, 0, 0, 0, 0, 4, 0, 2, 0, 0] as const;
/** 2-bit gate word (inhibit + AND outputs) → scale-degree transpose. The
 *  substrate's logic picks the tonal centre; flipping inputs shifts harmony. */
const SECTION_SHIFT = [0, 2, 4, 5] as const;
/** Lane tap index → arp scale degree (near→far taps climb the scale). */
const ARP_DEGREES = [0, 1, 2, 3, 4] as const;

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
  /** Normalized live-cell population, 0..1 (texture only). */
  population: number;
  /** Normalized glider density in the lane detectors, 0..1 (texture only). */
  activity: number;
  /** Computed bit 0 — the inhibit gate's output (A ∧ ¬B). Enables the bass. */
  gateHigh: boolean;
  /** Computed bit 1 — the wired AND gate's output (A ∧ B). Enables the pad. */
  andHigh: boolean;
  /** Per-lane glider-arrival pulses (one per music tap); fire the arp. */
  laneTriggers: readonly boolean[];
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
  /** Sub-bass layer (deep root, sidechained to the kick in the synth). */
  bass: Voice;
  /** Harmony layer: held chord tones (Hz), a 7th voicing. */
  chord: number[];
  /** Pad enable 0/1 (the AND gate bit) — silences the harmony when low. */
  padGate: number;
  /** Melody arp, retriggered by real glider arrivals on the lane taps. */
  lead: Voice;
  /** Filter-cutoff openness 0..1 (drives pad/lead movement in the synth). */
  cutoff: number;
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

  // The computer arranges: the two real gate outputs form a 2-bit word that
  // transposes the tonal centre. Bit 0 = inhibit (A∧¬B), bit 1 = AND (A∧B).
  const word = (obs.gateHigh ? 1 : 0) + (obs.andHigh ? 2 : 0);
  const shift = SECTION_SHIFT[word];

  // Harmony: a diatonic 7th voicing an octave below the arp (root/3rd/5th/7th),
  // moving once per bar and transposed by the gate word. The AND bit enables it.
  const chord = [deg, deg + 2, deg + 4, deg + 6].map(
    (i) => noteHz(params.root, degree(scale, i + shift)) * 0.5,
  );
  const padGate = obs.andHigh ? 1 : 0;

  // Sub-bass: two octaves below the chord, syncopated groove walking root↔fifth.
  // The inhibit bit enables it — flipping A/B mutes the low end. Sidechained.
  const bass: Voice = {
    freq:
      noteHz(params.root, degree(scale, deg + shift + BASS_MOVE[inBar])) * 0.25,
    gate: BASS_PATTERN[inBar] === 1 && obs.gateHigh ? 1 : 0,
  };

  // Beat: four-on-the-floor clock (drums are timing, not computation); dense
  // glider activity fills in extra hats as texture.
  const busy = obs.activity > 0.5;
  const kick = inBar % 4 === 0 ? 1 : 0;
  const snare = inBar % 8 === 4 ? 1 : 0;
  const hat = inBar % 2 === 0 || busy ? 1 : 0;

  // Filter cutoff: glider activity + population open the pad/arp filter — the
  // one place the statistical texture lives (the automaton breathing).
  const cutoff = clamp01(
    0.28 + 0.46 * obs.activity + 0.3 * clamp01(obs.population),
  );

  // Arp: physics-timed. Each lane tap fires when a glider actually arrives; the
  // highest-index arrival this step sets the note (near→far climbs the scale),
  // transposed by the gate word to sit above the chord.
  const fired = obs.laneTriggers.lastIndexOf(true);
  const arpDeg =
    shift +
    scale.length +
    (fired >= 0 ? ARP_DEGREES[fired % ARP_DEGREES.length] : 0);
  const lead: Voice = {
    freq: noteHz(params.root, degree(scale, arpDeg)),
    gate: fired >= 0 ? 1 : 0,
  };

  return { kick, snare, hat, bass, chord, padGate, lead, cutoff };
};
