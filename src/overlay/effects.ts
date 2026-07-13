// view: reusable field effects shared across overlay draws (center pad, bases,
// ship abilities). Pure — animation is derived from `now`.

import { lerp } from "../engine/physics";
import { SHAPE } from "../sprites";
import type { PushFn } from "./push";

/** Travel direction of the ping rings: outward (repel) or inward (attract). */
export type FieldDir = "out" | "in";

export interface ForceFieldOpts {
  /** Number of concurrent rings, staggered in phase. Default 4. */
  rings?: number;
  /** Full cycle of one ring, in ms. Larger = slower, calmer. Default 3200. */
  period?: number;
  /** Inner radius as a fraction of `radius` (ring's near end). Default 0.35. */
  rMin?: number;
  /** Outer radius as a fraction of `radius` (ring's far end). Default 1.55. */
  rMax?: number;
  /** Peak ring opacity at mid-life; fades to 0 at both ends. Default 0.7. */
  alpha?: number;
  /** ms divisor for the slow ring roll (visual spin). Default 4200. */
  spin?: number;
  /** "out" pushes rings core→rim (repel); "in" pulls rim→core. Default "out". */
  dir?: FieldDir;
}

/**
 * Concentric neon "ping" rings radiating from a point — a reusable force-field
 * visual. Each ring eases across its span and fades in at the near end / out at
 * the far end, the set staggered so a new wave leaves as the last dissolves.
 * `dir: "out"` reads as an outward push (repel); `dir: "in"` as an inward pull
 * (attract/collapse). `radius` is the base span in cells; `rgb` is the tint.
 */
export function drawForceField(
  push: PushFn,
  cx: number,
  cy: number,
  cellPx: number,
  cellPy: number,
  radius: number,
  now: number,
  rgb: readonly [number, number, number],
  opts: ForceFieldOpts = {},
): void {
  const rings = opts.rings ?? 4;
  const period = opts.period ?? 3200;
  const rMin = opts.rMin ?? 0.35;
  const rMax = opts.rMax ?? 1.55;
  const peak = opts.alpha ?? 0.7;
  const roll = now / (opts.spin ?? 4200);
  const inward = opts.dir === "in";
  for (let i = 0; i < rings; i++) {
    // Lifetime progress 0→1 (drives the fade), independent of travel direction.
    const p = (((now / period + i / rings) % 1) + 1) % 1;
    // Travel across the span: core→rim when out, rim→core when in.
    const travel = inward ? 1 - p : p;
    const eased = 1 - (1 - travel) * (1 - travel); // fast-out, gentle settle
    const rad = radius * lerp(rMin, rMax, eased);
    // Two superposed rings per wave, counter-rotating, so their angular
    // features beat against each other into a shimmering moiré.
    const alpha = Math.sin(p * Math.PI) * peak * 0.75; // fade in/out; halved-ish
    const tint: [number, number, number, number] = [
      rgb[0],
      rgb[1],
      rgb[2],
      alpha,
    ];
    push(cx, cy, rad * cellPx, rad * cellPy, roll, SHAPE.ring, tint);
    push(cx, cy, rad * cellPx, rad * cellPy, -roll, SHAPE.ring, tint);
  }
}
