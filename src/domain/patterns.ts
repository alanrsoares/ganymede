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
  let x = 0;
  let y = 0;
  let run = 0;
  let width = 0;

  for (const ch of body) {
    if (ch >= "0" && ch <= "9") {
      run = run * 10 + Number(ch);
      continue;
    }

    const count = run === 0 ? 1 : run;
    run = 0;

    switch (ch) {
      case "b":
        x += count;
        break;
      case "o":
        for (let i = 0; i < count; i++) cells.push([x + i, y]);
        x += count;
        break;
      case "$":
        width = Math.max(width, x);
        x = 0;
        y += count;
        break;
      case "!":
        width = Math.max(width, x);
        return ok({ width, height: y + 1, cells });
      default:
        if (ch.trim() === "") continue;
        return err({
          _tag: "InvalidRle",
          message: `Unexpected character '${ch}' in RLE`,
        });
    }
  }

  return err({ _tag: "InvalidRle", message: "RLE missing terminating '!'" });
};

/** Places a pattern's cells at an absolute grid offset. */
export const placePattern = (
  pattern: Pattern,
  offsetX: number,
  offsetY: number,
): Cell[] => pattern.cells.map(([x, y]) => [x + offsetX, y + offsetY]);

// --- Canonical patterns ---

export const GLIDER_RLE = "bob$2bo$3o!";

export const BLINKER_RLE = "3o!";

// Gosper glider gun: emits one glider every 30 generations.
export const GOSPER_GUN_RLE = [
  "24bo$22bobo$12b2o6b2o12b2o$11bo3bo4b2o12b2o$2o8bo5bo3b2o$2o8bo3bob2o4b",
  "obo$10bo5bo7bo$11bo3bo$12b2o!",
].join("");
