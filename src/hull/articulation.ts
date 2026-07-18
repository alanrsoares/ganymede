// TypeScript mirror of ship.wgsl's spineDeform — keep the two in sync.
// The renderer deforms hull vertices on the GPU; this mirror exists for the
// CPU-side consumers: plume nozzle anchors (game + drydock packers) shift by
// the same lateral offset so the flame stays glued to the swaying tail.
//
// y is the ship-local spine coordinate (nose +Y, body authored ≈ [-1.1, 1.1]).

import type { ArticulationDef } from "./catalog";

/** Tail end of the authored body — the wave envelope reaches full amp here. */
export const BODY_TAIL = -1.1;

/** Segment-quantised spine coordinate: segLen > 0 snaps y to its segment
 * centre so a whole carapace plate takes one rigid offset (hinge mode). */
export const spineY = (y: number, segLen: number): number =>
  segLen > 0 ? (Math.floor(y / segLen) + 0.5) * segLen : y;

/** Lateral (x) displacement of the spine at y. `a.amp` is the effective
 * amplitude — callers apply drive/drift scaling before passing it in,
 * exactly like the packed instance data the shader sees. */
export const spineOffset = (
  y: number,
  phase: number,
  curve: number,
  a: ArticulationDef,
): number => {
  const yq = spineY(y, a.segLen);
  // Envelope: 0 at the stiff head, 1 at the tail (explicit smoothstep — the
  // WGSL writes the same clamp+hermite so reversed edges behave identically).
  const t = Math.min(
    1,
    Math.max(0, (yq - a.headStiff) / (BODY_TAIL - a.headStiff)),
  );
  const env = t * t * (3 - 2 * t);
  const wave = Math.sin(yq * a.freq - phase) * a.amp * env;
  const d = a.headStiff - yq;
  const lean = yq <= a.headStiff ? curve * d * d : 0;
  return wave + lean;
};
