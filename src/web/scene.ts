// The GoL substrate scene, laid out as a left→right datapath: a clock (Gosper
// gun) drives a glider lane whose taps are the melody's arp; the zxcvbnm key row
// is the machine's input register, feeding two real GoL logic gates (inhibit
// A∧¬B and the wired AND A∧B) whose outputs are read back and mapped to the
// music. Every construct on the grid does something — the step-1 routing
// primitives (reflector/duplicator) stay in the codebase + tests but off-stage.
// main.ts owns the GPU engine and rendering; this module owns the substrate.
// Detector/gate readback goes through the same readRegion path the computer uses.

import { unwrapOk } from "@onrails/result";
import type { Cell } from "~/domain/gol";
import { GLIDER_RLE, parseRle, placePattern } from "~/domain/patterns";
import {
  countWindow,
  createEdgeDetector,
  createGliderAndGate,
  createGliderInhibitGate,
  createGunClock,
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
// Logic block, one band below the clock (verified collision-free on the
// composed 480×270 grid): inhibit on the left, AND to its right — the datapath
// reads clock → inputs → inhibit → AND → outputs.
const INHIBIT_BASE_X = 40;
const INHIBIT_BASE_Y = 150;
const AND_BASE_X = 200;
const AND_BASE_Y = 150;

export const PARITY_GENERATIONS = 120;
export const EXPECTED_LANE_DELAY =
  (MUSIC_DISTANCES[MUSIC_DISTANCES.length - 1] - MUSIC_DISTANCES[0]) *
  GLIDER_GENS_PER_CELL;

/** Labels for the real GoL substrate, anchored at their actual grid cells and
 *  reading as a datapath: clock/tape on top, the logic block below. */
export const SUBSTRATE_LABELS: readonly UiLabel[] = [
  { x: 24, y: 18, text: "CLK · Gosper gun" },
  { x: 60, y: 34, text: "WIRE · glider lane → arp" },
  { x: 74, y: 48, text: "EATER" },
  { x: 58, y: 144, text: "INHIBIT A∧¬B · keys z/x" },
  { x: 118, y: 218, text: "OUT → bass" },
  { x: 214, y: 144, text: "AND A∧B · keys c/v" },
  { x: 300, y: 250, text: "OUT → pad" },
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
  /** Advance the engine by `golSteps` (the gates are self-sustaining guns). */
  stepAndFeed(engine: GolEngine, golSteps: number): void;
  /** Async readback of the lane detectors and the gate output. */
  sample(engine: GolEngine): void;
  /** Lane detector windows with flash timing (for rendering). */
  detectorViews(): DetectorView[];
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
  const inhibitGate = createGliderInhibitGate(INHIBIT_BASE_X, INHIBIT_BASE_Y);
  const andGate = createGliderAndGate(AND_BASE_X, AND_BASE_Y);

  let inputA = true;
  let inputB = true;
  let andA = true;
  let andB = true;

  const buildSeed = (): Cell[] => [
    ...gunClock.seed,
    ...gunClock.laneEater(EATER_DISTANCE),
    ...inhibitGate.seed(inputA, inputB),
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
      // The gates are self-sustaining gun machines — just advance the engine.
      engine.step(golSteps);
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
