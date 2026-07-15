// Parity harness: the CPU reference for each ported kernel plus a diff. The CPU
// path is authoritative (it is what `bun test` exercises — no GPU there), so
// every kernel is validated against it. The check is PLAUSIBLE-divergence, not
// bit-exact: GPU floats differ from JS (Metal sqrt/div, non-associativity), so
// we assert relative error stays under a gameplay-safe threshold, not zero.

import { wrapDelta } from "../engine/physics";
import type { Arena } from "./kernels/separation";

// Deterministic seeded field (mulberry32, same family as engine/rng). Packs
// n ships as [x, y, 0, 0] per stride-4 slot — the vec4 SoA the GPU reads.
export const makeField = (
  n: number,
  arena: Arena,
  seed = 0x1234,
): Float32Array => {
  let s = seed ^ n;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const buf = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    buf[i * 4] = rnd() * arena.w;
    buf[i * 4 + 1] = rnd() * arena.h;
  }
  return buf;
};

// CPU separation reference — mirror of the WGSL kernel (and steerSeparation's
// omnidirectional core). Returns a Float32Array of length n*2 (fx, fy per ship).
export const cpuSeparation = (
  positions: Float32Array,
  n: number,
  arena: Arena,
  r: number,
): Float32Array => {
  const out = new Float32Array(n * 2);
  const r2 = r * r;
  for (let i = 0; i < n; i++) {
    const xi = positions[i * 4];
    const yi = positions[i * 4 + 1];
    let sx = 0;
    let sy = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const ax = wrapDelta(positions[j * 4], xi, arena.w); // obstacle -> self
      const ay = wrapDelta(positions[j * 4 + 1], yi, arena.h);
      const d2 = ax * ax + ay * ay;
      if (d2 >= r2 || d2 < 1e-6) continue;
      const dist = Math.sqrt(d2);
      const w = (1 - dist / r) / dist;
      sx += ax * w;
      sy += ay * w;
    }
    out[i * 2] = sx;
    out[i * 2 + 1] = sy;
  }
  return out;
};

export interface Divergence {
  maxAbsErr: number;
  maxRelErr: number;
  meanMag: number;
}

// Compare two equal-length result arrays (CPU ref vs GPU). maxRelErr ignores
// near-zero reference components (rel error is meaningless there).
export const compare = (ref: Float32Array, got: Float32Array): Divergence => {
  let maxAbsErr = 0;
  let maxRelErr = 0;
  let sum = 0;
  const len = Math.min(ref.length, got.length);
  for (let i = 0; i < len; i++) {
    const a = ref[i];
    const d = Math.abs(a - got[i]);
    if (d > maxAbsErr) maxAbsErr = d;
    if (Math.abs(a) > 1e-4) {
      const rel = d / Math.abs(a);
      if (rel > maxRelErr) maxRelErr = rel;
    }
    sum += Math.abs(a);
  }
  return {
    maxAbsErr,
    maxRelErr,
    meanMag: +(sum / len).toFixed(4),
  };
};
