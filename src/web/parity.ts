// GPU ≡ CPU parity check: advance the GPU engine and the tested CPU reference
// from the same seed and compare the whole grid. A mismatch means the compute
// shader diverged from real Game of Life. The CPU engine (domain/gol.ts) is the
// oracle. NOTE: this advances the passed engine by `generations`.

import type { Cell } from "~/domain/gol";
import { createGrid, stepGrid } from "~/domain/gol";
import type { GolEngine } from "./gol-gpu";

export const checkParity = async (
  engine: GolEngine,
  seed: Cell[],
  generations: number,
  gridW: number,
  gridH: number,
): Promise<boolean> => {
  engine.step(generations);
  const gpuCells = await engine.readRegion(0, 0, gridW, gridH);
  let cpu = createGrid(gridW, gridH, seed);
  for (let i = 0; i < generations; i++) cpu = stepGrid(cpu);
  for (let i = 0; i < gpuCells.length; i++) {
    if (gpuCells[i] !== cpu.cells[i]) return false;
  }
  return true;
};
