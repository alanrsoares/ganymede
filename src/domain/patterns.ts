import { err, ok, type Result } from "@onrails/result";
import type { Cell } from "./gol";

export interface Pattern {
  readonly width: number;
  readonly height: number;
  readonly cells: Cell[]; // relative to the pattern's top-left corner
}

export type RleError = {
  readonly _tag: "InvalidRle";
  readonly message: string;
};

/** Cursor tracks position/width while scanning an RLE body; mutated in place. */
type RleCursor = { x: number; y: number; width: number };

/** Outcome of applying a single non-digit RLE token to the cursor/cells. */
type RleTokenOutcome =
  | { readonly _tag: "continue" }
  | { readonly _tag: "done"; readonly pattern: Pattern }
  | { readonly _tag: "error"; readonly error: RleError };

/** Appends `count` consecutive live cells starting at (x, y). */
const pushLiveRun = (
  cells: Cell[],
  x: number,
  y: number,
  count: number,
): void => {
  for (let i = 0; i < count; i++) cells.push([x + i, y]);
};

/** Applies one RLE token (`b`, `o`, `$`, `!`, or whitespace/unknown) to the cursor. */
const applyRleToken = (
  ch: string,
  count: number,
  cursor: RleCursor,
  cells: Cell[],
): RleTokenOutcome => {
  switch (ch) {
    case "b":
      cursor.x += count;
      return { _tag: "continue" };
    case "o":
      pushLiveRun(cells, cursor.x, cursor.y, count);
      cursor.x += count;
      return { _tag: "continue" };
    case "$":
      cursor.width = Math.max(cursor.width, cursor.x);
      cursor.x = 0;
      cursor.y += count;
      return { _tag: "continue" };
    case "!":
      cursor.width = Math.max(cursor.width, cursor.x);
      return {
        _tag: "done",
        pattern: { width: cursor.width, height: cursor.y + 1, cells },
      };
    default:
      if (ch.trim() === "") return { _tag: "continue" };
      return {
        _tag: "error",
        error: {
          _tag: "InvalidRle",
          message: `Unexpected character '${ch}' in RLE`,
        },
      };
  }
};

/**
 * Parses the standard Game of Life RLE format: `b` dead, `o` alive,
 * `$` end of row, `!` end of pattern, digits as run counts. Header and
 * `#` comment lines are skipped.
 */
export const parseRle = (rle: string): Result<Pattern, RleError> => {
  const body = rle
    .split("\n")
    .filter((line) => !line.startsWith("#") && !line.includes("="))
    .join("")
    .trim();

  const cells: Cell[] = [];
  const cursor: RleCursor = { x: 0, y: 0, width: 0 };
  let run = 0;

  for (const ch of body) {
    if (ch >= "0" && ch <= "9") {
      run = run * 10 + Number(ch);
      continue;
    }

    const count = run === 0 ? 1 : run;
    run = 0;

    const outcome = applyRleToken(ch, count, cursor, cells);
    if (outcome._tag === "done") return ok(outcome.pattern);
    if (outcome._tag === "error") return err(outcome.error);
  }

  return err({ _tag: "InvalidRle", message: "RLE missing terminating '!'" });
};

/** Places a pattern's cells at an absolute grid offset. */
export const placePattern = (
  pattern: Pattern,
  offsetX: number,
  offsetY: number,
): Cell[] => pattern.cells.map(([x, y]) => [x + offsetX, y + offsetY]);

/** Rotates a pattern 90° clockwise. */
export const rotate90 = (p: Pattern): Pattern => ({
  width: p.height,
  height: p.width,
  cells: p.cells.map(([x, y]) => [p.height - 1 - y, x]),
});

/** Mirrors a pattern horizontally. */
export const flipH = (p: Pattern): Pattern => ({
  ...p,
  cells: p.cells.map(([x, y]) => [p.width - 1 - x, y]),
});

/** All 8 orientations of a pattern (4 rotations x optional mirror). */
export const orientations = (p: Pattern): Pattern[] => {
  const out: Pattern[] = [];
  let current = p;
  for (let i = 0; i < 4; i++) {
    out.push(current, flipH(current));
    current = rotate90(current);
  }
  return out;
};

// --- Canonical patterns ---

export const GLIDER_RLE = "bob$2bo$3o!";

export const BLINKER_RLE = "3o!";

// Eater 1 (fishhook): still life that absorbs gliders arriving on the
// right lane, recovering unchanged between hits.
export const EATER_RLE = "2o$obo$2bo$2b2o!";

// Gosper glider gun: emits one glider every 30 generations.
export const GOSPER_GUN_RLE = [
  "24bo$22bobo$12b2o6b2o12b2o$11bo3bo4b2o12b2o$2o8bo5bo3b2o$2o8bo3bob2o4b",
  "obo$10bo5bo7bo$11bo3bo$12b2o!",
].join("");

// Snark: Mike Playle's stable 90-degree glider reflector (2013), with its
// demonstration glider stripped — 52 still-life cells, so it is completely
// static until a glider arrives. Turns an NE-bound glider into an SE-bound
// one. Verified against the CPU oracle. https://conwaylife.com/wiki/Snark
// Glider duplicator (fan-out): two internal Gosper guns split one input glider
// into two identical outputs (one NE, one SE). From conwaylife.com/wiki/
// Glider_duplicator (via github shuaitq/Game-of-Life). Includes a demo input
// glider (top-left) which substrate.ts exposes and removes from the machine.
export const GLIDER_DUPLICATOR_RLE = [
  "x = 50, y = 47, rule = b3/s23",
  "44b2o4b$44b2o4b9$41b2obob2o2b2$41bo5bo2b2$42b2ob2o3b$44bo5b3$38b2o6bo",
  "3b$37bobo5bobo2b$12bo26bo4bo3bob$13bo30b5ob$11b3o29b2o3b2o$44b5ob$45b",
  "3o2b$46bo3b$24b2o4b3o17b$24b2o6bo17b$31bo18b5$23b2o25b$22bobo21b2o2b$",
  "24bo21b2o2b$13bo36b$12b4o34b$11b2obobo6bobo24b$2o8b3obo2bo3bo3bo24b$2o",
  "9b2obobo4bo28b$12b4o4bo4bo24b$13bo7bo28b$21bo3bo6b2o16b$23bobo6bobo15b",
  "$34bo15b$34b2o!",
].join("\n");

export const SNARK_REFLECTOR: Pattern = {
  width: 17,
  height: 23,
  cells: [
    [6, 0],
    [7, 0],
    [11, 0],
    [12, 0],
    [6, 1],
    [7, 1],
    [10, 1],
    [12, 1],
    [13, 1],
    [14, 1],
    [10, 2],
    [15, 2],
    [6, 3],
    [7, 3],
    [8, 3],
    [9, 3],
    [11, 3],
    [12, 3],
    [15, 3],
    [6, 4],
    [9, 4],
    [11, 4],
    [13, 4],
    [15, 4],
    [16, 4],
    [9, 5],
    [11, 5],
    [13, 5],
    [15, 5],
    [10, 6],
    [11, 6],
    [13, 6],
    [15, 6],
    [14, 7],
    [0, 9],
    [1, 9],
    [1, 10],
    [9, 10],
    [10, 10],
    [1, 11],
    [3, 11],
    [9, 11],
    [10, 11],
    [2, 12],
    [3, 12],
    [12, 19],
    [13, 19],
    [12, 20],
    [13, 21],
    [14, 21],
    [15, 21],
    [15, 22],
  ],
};
