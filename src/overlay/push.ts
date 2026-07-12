// view: shared core for the overlay draw modules — the tint type, the push
// function signature every `draw*` helper uses, and the pusher that owns the
// flat sprite instance buffer + write cursor.

import { FLOATS_PER_INSTANCE, MAX_INSTANCES } from "../gpu";

export type Rgba = readonly [number, number, number, number];

// Emits one flat sprite instance (screen center, half-extents, rotation,
// shape id, RGBA tint, layer). Shared by every `draw*` helper below.
export type PushFn = (
  cx: number,
  cy: number,
  hx: number,
  hy: number,
  rot: number,
  shape: number,
  color: Rgba,
  layer?: number,
) => void;

// Owns the flat sprite instance buffer + write cursor. `reset` rewinds the
// cursor at the start of a frame; `push` appends one instance (dropping any
// overflow past MAX_INSTANCES, warning once).
export function createPusher(instances: Float32Array<ArrayBuffer>) {
  let count = 0;
  let warnedOverflow = false;
  const push: PushFn = (cx, cy, hx, hy, rot, shape, color, layer = 0) => {
    if (count >= MAX_INSTANCES) {
      if (!warnedOverflow) {
        warnedOverflow = true;
        console.warn(
          `overlay: hit MAX_INSTANCES (${MAX_INSTANCES}); sprites dropped this frame — raise the cap.`,
        );
      }
      return;
    }
    instances.set(
      [cx, cy, hx, hy, rot, shape, layer, 0, ...color],
      count * FLOATS_PER_INSTANCE,
    );
    count++;
  };
  return {
    push,
    reset: () => {
      count = 0;
    },
    getCount: () => count,
  };
}
