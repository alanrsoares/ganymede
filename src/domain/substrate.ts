// GoL substrate for circuit components: a Gosper gun is a Clock, a glider
// lane is a Wire, and a detector window is how pulses are read back out of
// the automaton. Works on the CPU reference grid (bun-testable); the browser
// feeds the same detection logic from GPU readbacks.

import type { Cell } from "./gol";
import { aliveCells, createGrid, type GolGrid, stepGrid } from "./gol";
import { GOSPER_GUN_RLE, parseRle, placePattern } from "./patterns";

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
}

export const createGunClock = (gunX: number, gunY: number): GunClock => {
  const gun = parseRle(GOSPER_GUN_RLE);
  if (gun._tag === "Err") throw new Error("GOSPER_GUN_RLE failed to parse");

  return {
    seed: placePattern(gun.value, gunX, gunY),
    laneDetector: (distance, size = 6) => ({
      x: gunX + LANE_DIAGONAL_OFFSET + distance - Math.floor(size / 2),
      y: gunY + distance - Math.floor(size / 2),
      size,
    }),
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
