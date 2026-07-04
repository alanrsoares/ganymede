// CPU reference implementation of Conway's Game of Life (toroidal grid).
// This is the oracle the WebGPU compute substrate is verified against.

export interface GolGrid {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array; // row-major, 1 = alive
}

export type Cell = readonly [x: number, y: number];

export const createGrid = (
  width: number,
  height: number,
  alive: Iterable<Cell> = [],
): GolGrid => {
  const cells = new Uint8Array(width * height);
  for (const [x, y] of alive) {
    const wx = ((x % width) + width) % width;
    const wy = ((y % height) + height) % height;
    cells[wy * width + wx] = 1;
  }
  return { width, height, cells };
};

export const stepGrid = (grid: GolGrid): GolGrid => {
  const { width, height, cells } = grid;
  const next = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const up = ((y - 1 + height) % height) * width;
    const mid = y * width;
    const down = ((y + 1) % height) * width;

    for (let x = 0; x < width; x++) {
      const left = (x - 1 + width) % width;
      const right = (x + 1) % width;

      const count =
        cells[up + left] +
        cells[up + x] +
        cells[up + right] +
        cells[mid + left] +
        cells[mid + right] +
        cells[down + left] +
        cells[down + x] +
        cells[down + right];

      const alive = cells[mid + x] === 1;
      next[mid + x] =
        (alive && (count === 2 || count === 3)) || count === 3 ? 1 : 0;
    }
  }

  return { width, height, cells: next };
};

export const population = (grid: GolGrid): number => {
  let count = 0;
  for (const cell of grid.cells) count += cell;
  return count;
};

export const aliveCells = (grid: GolGrid): Cell[] => {
  const out: Cell[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (grid.cells[y * grid.width + x] === 1) out.push([x, y]);
    }
  }
  return out;
};
