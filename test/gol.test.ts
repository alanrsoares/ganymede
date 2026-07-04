import { describe, expect, test } from "bun:test";
import { unwrapOk } from "@onrails/result";
import {
  aliveCells,
  createGrid,
  type GolGrid,
  population,
  stepGrid,
} from "~/domain/gol";
import {
  BLINKER_RLE,
  GLIDER_RLE,
  GOSPER_GUN_RLE,
  parseRle,
  placePattern,
} from "~/domain/patterns";

const stepN = (grid: GolGrid, n: number): GolGrid => {
  let g = grid;
  for (let i = 0; i < n; i++) g = stepGrid(g);
  return g;
};

describe("Game of Life reference engine", () => {
  test("block is a still life", () => {
    const block = createGrid(6, 6, [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
    ]);
    expect(stepGrid(block).cells).toEqual(block.cells);
  });

  test("blinker oscillates with period 2", () => {
    const blinker = parseRle(BLINKER_RLE);
    const grid = createGrid(8, 8, placePattern(unwrapOk(blinker), 2, 3));

    const g1 = stepGrid(grid);
    expect(g1.cells).not.toEqual(grid.cells);
    expect(stepGrid(g1).cells).toEqual(grid.cells);
  });

  test("glider translates by (1,1) every 4 generations", () => {
    const glider = unwrapOk(parseRle(GLIDER_RLE));
    const grid = createGrid(20, 20, placePattern(glider, 3, 3));

    const after4 = stepN(grid, 4);
    const expected = createGrid(20, 20, placePattern(glider, 4, 4));
    expect(after4.cells).toEqual(expected.cells);
  });

  test("glider wraps the toroidal edge", () => {
    const glider = unwrapOk(parseRle(GLIDER_RLE));
    const grid = createGrid(12, 12, placePattern(glider, 9, 9));

    // 4 * 12 generations: full lap around the torus, back to start.
    expect(stepN(grid, 48).cells).toEqual(grid.cells);
  });

  test("Gosper gun emits a glider every 30 generations", () => {
    const gun = unwrapOk(parseRle(GOSPER_GUN_RLE));
    expect(gun.cells.length).toBe(36);

    const grid = createGrid(200, 200, placePattern(gun, 4, 4));
    const p0 = population(grid);

    // After the gun stabilizes into its cycle, population grows by exactly
    // one glider (5 cells) per 30 generations.
    const at120 = population(stepN(grid, 120));
    const at150 = population(stepN(grid, 150));
    const at180 = population(stepN(grid, 180));
    expect(at150 - at120).toBe(5);
    expect(at180 - at150).toBe(5);
    expect(at120).toBeGreaterThan(p0);
  });

  test("aliveCells round-trips through createGrid", () => {
    const glider = unwrapOk(parseRle(GLIDER_RLE));
    const grid = createGrid(10, 10, placePattern(glider, 2, 2));
    expect(createGrid(10, 10, aliveCells(grid)).cells).toEqual(grid.cells);
  });
});

describe("RLE parser", () => {
  test("parses glider dimensions and cells", () => {
    const glider = unwrapOk(parseRle(GLIDER_RLE));
    expect(glider.width).toBe(3);
    expect(glider.height).toBe(3);
    expect(glider.cells).toEqual([
      [1, 0],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  test("skips header and comment lines", () => {
    const res = parseRle("#N Glider\nx = 3, y = 3, rule = B3/S23\nbob$2bo$3o!");
    expect(unwrapOk(res).cells.length).toBe(5);
  });

  test("rejects malformed input", () => {
    expect(parseRle("3o")._tag).toBe("Err");
    expect(parseRle("3z!")._tag).toBe("Err");
  });
});
