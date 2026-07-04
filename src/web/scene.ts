// The GoL substrate scene: which real Game of Life constructs live on the grid
// (clock gun + wire lane + eater, the A AND NOT B inhibit gate, and the routing
// showcase of a reflector + duplicator), how they are seeded, fed, sampled, and
// observed. main.ts owns the GPU engine and rendering; this module owns the
// substrate. Detector/gate readback goes through the same readRegion path the
// eventual computer will use to read pulses back out of the automaton.

import { unwrapOk } from "@onrails/result";
import type { Cell } from "~/domain/gol";
import { GLIDER_RLE, parseRle, placePattern } from "~/domain/patterns";
import {
  countWindow,
  createDuplicator,
  createEdgeDetector,
  createGliderAndGate,
  createGliderInhibitGate,
  createGunClock,
  createReflector,
  type Detector,
  GLIDER_GENS_PER_CELL,
} from "~/domain/substrate";
import type { GolEngine } from "./gol-gpu";
import type { UiLabel } from "./ui";

const GUN_X = 6;
const GUN_Y = 6;
// Detector taps down the clock's glider lane — each is a pentatonic step, so
// the crossings play a generative arpeggio timed by the automaton itself.
const MUSIC_DISTANCES = [16, 21, 26, 31, 36];
const EATER_DISTANCE = 40;
const NOT_BASE_X = 40;
const NOT_BASE_Y = 150;
// Routing showcase (step 1 primitives).
const REFLECT_BASE_X = 320;
const REFLECT_BASE_Y = 30;
const REFLECT_INJECT_PERIOD = 64; // > Snark 43-gen recovery time
const DUP_BASE_X = 300;
const DUP_BASE_Y = 150;
// Physical AND gate (step 2): mirrored NOT wired into an inhibit, out = A ∧ B.
// Placed in the clear right-center band, clear of reflector/duplicator.
const AND_BASE_X = 200;
const AND_BASE_Y = 40;

export const PARITY_GENERATIONS = 120;
export const EXPECTED_LANE_DELAY =
  (MUSIC_DISTANCES[MUSIC_DISTANCES.length - 1] - MUSIC_DISTANCES[0]) *
  GLIDER_GENS_PER_CELL;

/** Labels for the real GoL substrate, anchored at their actual grid cells. */
export const SUBSTRATE_LABELS: readonly UiLabel[] = [
  { x: 24, y: 18, text: "CLK · Gosper gun" },
  { x: 60, y: 34, text: "WIRE · glider lane" },
  { x: 74, y: 48, text: "EATER" },
  { x: 58, y: 144, text: "A · carrier gun" },
  { x: 129, y: 143, text: "B · deleter gun" },
  { x: 118, y: 218, text: "OUT · A∧¬B" },
  { x: 330, y: 20, text: "REFLECTOR · 90° turn" },
  { x: 315, y: 205, text: "DUPLICATOR · fan-out →2" },
  { x: 214, y: 30, text: 'AND · A∧B (keys "c"/"d")' },
];

/** A detector window plus the wall-clock time until which it should flash. */
export interface DetectorView {
  readonly det: Detector;
  readonly flashUntil: number;
}

/** Automaton observations the music composer and HUD consume. */
export interface SceneObservation {
  readonly activity: number;
  readonly gateFlowing: boolean;
  readonly andFlowing: boolean;
  /** Per-lane glider-arrival note gates (drive the physics-timed arp). */
  readonly laneTriggers: readonly boolean[];
  readonly laneNear: number;
  readonly laneFar: number;
  readonly laneDelay: number | null;
}

export interface Scene {
  readonly labels: readonly UiLabel[];
  /** Seed for the current inhibit inputs (used for engine init + parity). */
  seed(): Cell[];
  readonly inputA: boolean;
  readonly inputB: boolean;
  readonly andA: boolean;
  readonly andB: boolean;
  /** Toggle an input (inhibit a/b, AND c/d) and rebuild the scene. */
  toggleInput(engine: GolEngine, which: "a" | "b" | "c" | "d"): void;
  /** Drop a glider at a grid cell (the click interaction). */
  drop(engine: GolEngine, gx: number, gy: number): void;
  /** Advance the engine by `golSteps`, feeding the routing constructs on a
   *  30-gen-aligned schedule (duplicator stream + spaced reflector input). */
  stepAndFeed(engine: GolEngine, golSteps: number): void;
  /** Async readback of the lane detectors and the gate output. */
  sample(engine: GolEngine): void;
  /** Lane detector windows with flash timing (for rendering). */
  detectorViews(): DetectorView[];
  /** Purple routing output markers (for rendering). */
  routingMarkers(): Detector[];
  /** The inhibit gate output window with flash timing. */
  gateView(): DetectorView;
  /** The AND gate output window with flash timing. */
  andView(): DetectorView;
  /** Observations for the current frame. */
  observe(now: number): SceneObservation;
}

export const createScene = (): Scene => {
  const glider = unwrapOk(parseRle(GLIDER_RLE));
  const gunClock = createGunClock(GUN_X, GUN_Y);
  const inhibitGate = createGliderInhibitGate(NOT_BASE_X, NOT_BASE_Y);
  const reflector = createReflector(REFLECT_BASE_X, REFLECT_BASE_Y);
  const duplicator = createDuplicator(DUP_BASE_X, DUP_BASE_Y);
  const andGate = createGliderAndGate(AND_BASE_X, AND_BASE_Y);

  let inputA = true;
  let inputB = true;
  let andA = true;
  let andB = true;

  // The duplicator machine is seeded with its first input so the parity check
  // sees a clean, non-chaotic machine.
  const buildSeed = (): Cell[] => [
    ...gunClock.seed,
    ...gunClock.laneEater(EATER_DISTANCE),
    ...inhibitGate.seed(inputA, inputB),
    ...reflector.seed,
    ...duplicator.seed,
    ...duplicator.inputGlider(),
    ...andGate.seed(andA, andB),
  ];

  const detectors = MUSIC_DISTANCES.map((d) => gunClock.laneDetector(d));
  const edgeDetectors = detectors.map(() => createEdgeDetector());
  const detections: number[][] = detectors.map(() => []);
  const detectorFlash = detectors.map(() => 0);
  // Short per-lane note-gate window: a glider arrival opens the arp voice for
  // ~110ms — long enough to retrigger the envelope, short enough to pluck.
  const laneMusicUntil = detectors.map(() => 0);
  const windowLevel = detectors.map(() => 0);

  const gateOut = inhibitGate.output;
  let gateOutEdge = createEdgeDetector();
  let gateOutFlash = 0;

  const andOut = andGate.output;
  let andOutEdge = createEdgeDetector();
  let andOutFlash = 0;

  return {
    labels: SUBSTRATE_LABELS,
    seed: () => buildSeed(),
    get inputA() {
      return inputA;
    },
    get inputB() {
      return inputB;
    },
    get andA() {
      return andA;
    },
    get andB() {
      return andB;
    },
    toggleInput: (engine, which) => {
      if (which === "a") inputA = !inputA;
      else if (which === "b") inputB = !inputB;
      else if (which === "c") andA = !andA;
      else andB = !andB;
      engine.reset(buildSeed());
      gateOutEdge = createEdgeDetector();
      andOutEdge = createEdgeDetector();
    },
    drop: (engine, gx, gy) => {
      engine.inject(placePattern(glider, gx, gy));
    },
    stepAndFeed: (engine, golSteps) => {
      let remaining = golSteps;
      while (remaining > 0) {
        const gen = engine.generation();
        const nextBoundary = (Math.floor(gen / 30) + 1) * 30;
        const chunk = Math.min(remaining, nextBoundary - gen);
        engine.step(chunk);
        remaining -= chunk;
        const nowGen = engine.generation();
        if (nowGen % 30 === 0) engine.inject(duplicator.inputGlider());
        if (
          Math.floor(nowGen / REFLECT_INJECT_PERIOD) >
          Math.floor(gen / REFLECT_INJECT_PERIOD)
        ) {
          engine.inject(reflector.inputGlider(2));
        }
      }
    },
    sample: (engine) => {
      detectors.forEach((det, i) => {
        const gen = engine.generation();
        void engine
          .readRegion(det.x, det.y, det.size, det.size)
          .then((cells) => {
            const level = countWindow(cells);
            windowLevel[i] = level;
            if (edgeDetectors[i].sample(level)) {
              detections[i].push(gen);
              detectorFlash[i] = performance.now() + 400;
              laneMusicUntil[i] = performance.now() + 110;
            }
          });
      });
      void engine
        .readRegion(gateOut.x, gateOut.y, gateOut.size, gateOut.size)
        .then((cells) => {
          if (gateOutEdge.sample(countWindow(cells))) {
            gateOutFlash = performance.now() + 400;
          }
        });
      void engine
        .readRegion(andOut.x, andOut.y, andOut.size, andOut.size)
        .then((cells) => {
          if (andOutEdge.sample(countWindow(cells))) {
            andOutFlash = performance.now() + 400;
          }
        });
    },
    detectorViews: () =>
      detectors.map((det, i) => ({ det, flashUntil: detectorFlash[i] })),
    routingMarkers: () => [
      reflector.outputDetector(30),
      duplicator.outputNE(45),
      duplicator.outputSE(45),
    ],
    gateView: () => ({ det: gateOut, flashUntil: gateOutFlash }),
    andView: () => ({ det: andOut, flashUntil: andOutFlash }),
    observe: (now) => {
      const activity = Math.min(
        1,
        windowLevel.reduce((a, c) => a + c, 0) / (windowLevel.length * 3),
      );
      const nearHits = detections[0];
      const farHits = detections[detections.length - 1];
      const shared = Math.min(nearHits.length, farHits.length);
      return {
        activity,
        gateFlowing: now - gateOutFlash < 1200,
        andFlowing: now - andOutFlash < 1200,
        laneTriggers: laneMusicUntil.map((until) => now < until),
        laneNear: nearHits.length,
        laneFar: farHits.length,
        laneDelay:
          shared > 0 ? farHits[shared - 1] - nearHits[shared - 1] : null,
      };
    },
  };
};
