// GoL substrate for circuit components: a Gosper gun is a Clock, a glider
// lane is a Wire, and a detector window is how pulses are read back out of
// the automaton. Works on the CPU reference grid (bun-testable); the browser
// feeds the same detection logic from GPU readbacks.

import type { Cell } from "./gol";
import { aliveCells, createGrid, type GolGrid, stepGrid } from "./gol";
import {
  EATER_RLE,
  flipH,
  GOSPER_GUN_RLE,
  parseRle,
  placePattern,
} from "./patterns";

/** The Gosper gun emits one glider every 30 generations. */
export const GUN_PERIOD = 30;

/** A glider advances one cell diagonally every 4 generations (speed c/4). */
export const GLIDER_GENS_PER_CELL = 4;

/**
 * Gliders leave the gun heading southeast along the diagonal
 * x - y ≈ LANE_DIAGONAL_OFFSET (relative to the gun's top-left corner).
 * Calibrated empirically against the CPU reference engine.
 */
export const LANE_DIAGONAL_OFFSET = 14;

export interface Detector {
  readonly x: number; // top-left, grid coordinates
  readonly y: number;
  readonly size: number;
}

export interface GunClock {
  readonly seed: Cell[];
  /** Detector window centered on the glider lane, `distance` cells below the gun. */
  laneDetector(distance: number, size?: number): Detector;
  /**
   * Eater 1 placed to absorb the gun's gliders `distance` cells below the
   * gun, terminating the lane cleanly. Calibrated: the as-parsed fishhook
   * orientation absorbs at every distance in [24, 44] (phase-insensitive).
   */
  laneEater(distance: number): Cell[];
}

const mustParse = (rle: string, name: string) => {
  const parsed = parseRle(rle);
  if (parsed._tag === "Err") throw new Error(`${name} failed to parse`);
  return parsed.value;
};

export const createGunClock = (gunX: number, gunY: number): GunClock => {
  const gun = mustParse(GOSPER_GUN_RLE, "GOSPER_GUN_RLE");
  const eater = mustParse(EATER_RLE, "EATER_RLE");

  return {
    seed: placePattern(gun, gunX, gunY),
    laneDetector: (distance, size = 6) => ({
      x: gunX + LANE_DIAGONAL_OFFSET + distance - Math.floor(size / 2),
      y: gunY + distance - Math.floor(size / 2),
      size,
    }),
    laneEater: (distance) =>
      placePattern(
        eater,
        gunX + LANE_DIAGONAL_OFFSET + distance,
        gunY + distance,
      ),
  };
};

// --- Glider inhibit gate (A AND NOT B) ---
//
// Two perpendicular glider streams annihilate where they cross: a carrier gun
// (input A, SE lane) and a deleter gun (input B, mirrored, SW lane). The
// carrier is the output. When B is present its gliders delete the carrier at
// the crossing, so the output goes dark; the output flows only when A is
// present and B is absent. This is the AND-NOT primitive: out = A AND NOT B.
// A NOT gate is the special case where A is a constant-on carrier.
// Relative gun placement and the output detector are calibrated against the
// CPU reference engine (see test/substrate.test.ts).

/** Deleter (B) gun offset relative to the carrier (A) gun, for the crossing. */
const INHIBIT_B_DX = 71;
const INHIBIT_B_DY = -1;
/** Output detector distance along the carrier lane, past the crossing. */
const INHIBIT_OUTPUT_DISTANCE = 60;

export interface GliderInhibitGate {
  /** Carrier gun (A) when `aHigh`, plus the deleter gun (B) when `bHigh`. */
  seed(aHigh: boolean, bHigh: boolean): Cell[];
  /** Detector on the output (carrier) lane, downstream of the crossing. */
  readonly output: Detector;
}

export const createGliderInhibitGate = (
  baseX: number,
  baseY: number,
): GliderInhibitGate => {
  const gun = mustParse(GOSPER_GUN_RLE, "GOSPER_GUN_RLE");
  const deleterGun = flipH(gun);
  const carrierSeed = placePattern(gun, baseX, baseY);
  const deleterSeed = placePattern(
    deleterGun,
    baseX + INHIBIT_B_DX,
    baseY + INHIBIT_B_DY,
  );
  const d = INHIBIT_OUTPUT_DISTANCE;

  return {
    seed: (aHigh, bHigh) => [
      ...(aHigh ? carrierSeed : []),
      ...(bHigh ? deleterSeed : []),
    ],
    output: {
      x: baseX + LANE_DIAGONAL_OFFSET + d - 3,
      y: baseY + d - 3,
      size: 6,
    },
  };
};

export interface GliderNotGate {
  /** Carrier gun (constant on), plus the input gun when `inputHigh`. */
  seed(inputHigh: boolean): Cell[];
  /** Detector on the output (carrier) lane, downstream of the crossing. */
  readonly output: Detector;
}

/** NOT is the inhibit gate with a constant-on carrier: out = 1 AND NOT input. */
export const createGliderNotGate = (
  baseX: number,
  baseY: number,
): GliderNotGate => {
  const inhibit = createGliderInhibitGate(baseX, baseY);
  return {
    seed: (inputHigh) => inhibit.seed(true, inputHigh),
    output: inhibit.output,
  };
};

/** Sums alive cells inside a detector window (any 0/1 cell array). */
export const countWindow = (cells: ArrayLike<number>): number => {
  let count = 0;
  for (let i = 0; i < cells.length; i++) count += cells[i];
  return count;
};

const countDetector = (grid: GolGrid, det: Detector): number => {
  let count = 0;
  for (let dy = 0; dy < det.size; dy++) {
    const row = (det.y + dy) * grid.width;
    for (let dx = 0; dx < det.size; dx++) {
      count += grid.cells[row + det.x + dx];
    }
  }
  return count;
};

export interface EdgeDetector {
  /** Feeds one sample; returns true on the rising edge of a glider crossing. */
  sample(aliveCount: number): boolean;
}

/**
 * Rising-edge detector with hysteresis: fires when the window fills to
 * `threshold`, re-arms only after the window fully empties.
 */
export const createEdgeDetector = (threshold = 3): EdgeDetector => {
  let armed = true;
  return {
    sample: (aliveCount) => {
      if (armed && aliveCount >= threshold) {
        armed = false;
        return true;
      }
      if (aliveCount === 0) armed = true;
      return false;
    },
  };
};

/**
 * Runs the CPU substrate for `generations`, returning the generation numbers
 * at which each detector saw a glider cross.
 */
export const runSubstrate = (
  seed: Cell[],
  width: number,
  height: number,
  generations: number,
  detectors: Detector[],
): number[][] => {
  let grid = createGrid(width, height, seed);
  const edges = detectors.map(() => createEdgeDetector());
  const detections: number[][] = detectors.map(() => []);

  for (let gen = 1; gen <= generations; gen++) {
    grid = stepGrid(grid);
    detectors.forEach((det, i) => {
      if (edges[i].sample(countDetector(grid, det))) {
        detections[i].push(gen);
      }
    });
  }

  return detections;
};

/** Convenience for calibration and debugging: cells outside a bounding box. */
export const cellsOutside = (
  grid: GolGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Cell[] =>
  aliveCells(grid).filter(([x, y]) => x < x0 || y < y0 || x > x1 || y > y1);
