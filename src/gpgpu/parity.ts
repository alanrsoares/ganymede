// Parity harness: the CPU reference for each ported kernel plus a diff. The CPU
// path is authoritative (it is what `bun test` exercises — no GPU there), so
// every kernel is validated against it. The check is PLAUSIBLE-divergence, not
// bit-exact: GPU floats differ from JS (Metal sqrt/div, non-associativity), so
// we assert relative error stays under a gameplay-safe threshold, not zero.

import { normalize, wrapDelta } from "../engine/physics";
import type { FlockTuning } from "./kernels/flock";
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

const NUM_TEAMS = 4;

// Deterministic flock field: posHead [x,y,dx,dy] (position + heading unit vec)
// and velTeam [vx,vy,team,0] per ship, the two SoA inputs FlockKernel reads.
export const makeFlockField = (
  n: number,
  arena: Arena,
  seed = 0x51ed,
): { posHead: Float32Array; velTeam: Float32Array } => {
  let s = seed ^ n;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const posHead = new Float32Array(n * 4);
  const velTeam = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    posHead[i * 4] = rnd() * arena.w;
    posHead[i * 4 + 1] = rnd() * arena.h;
    posHead[i * 4 + 2] = Math.cos(a); // heading unit vec
    posHead[i * 4 + 3] = Math.sin(a);
    velTeam[i * 4] = (rnd() * 2 - 1) * 1.5; // velocity
    velTeam[i * 4 + 1] = (rnd() * 2 - 1) * 1.5;
    velTeam[i * 4 + 2] = Math.floor(rnd() * NUM_TEAMS); // team
  }
  return { posHead, velTeam };
};

// Per-ship neighbour accumulation for cpuFlock (separation over all ships +
// same-team align/cohere sums). Split out to keep each function simple.
interface FlockAccum {
  sepx: number;
  sepy: number;
  vx: number;
  vy: number;
  cx: number;
  cy: number;
  cnt: number;
}

const accumulateFlock = (
  i: number,
  posHead: Float32Array,
  velTeam: Float32Array,
  n: number,
  arena: Arena,
  t: FlockTuning,
): FlockAccum => {
  const xi = posHead[i * 4];
  const yi = posHead[i * 4 + 1];
  const teamI = velTeam[i * 4 + 2];
  const sepR2 = t.sepR * t.sepR;
  const flockR2 = t.flockR * t.flockR;
  const a: FlockAccum = {
    sepx: 0,
    sepy: 0,
    vx: 0,
    vy: 0,
    cx: 0,
    cy: 0,
    cnt: 0,
  };
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const sx = wrapDelta(posHead[j * 4], xi, arena.w); // obstacle -> self
    const sy = wrapDelta(posHead[j * 4 + 1], yi, arena.h);
    const sd2 = sx * sx + sy * sy;
    if (sd2 > 1e-6 && sd2 < sepR2) {
      const w = (1 - Math.sqrt(sd2) / t.sepR) / Math.sqrt(sd2);
      a.sepx += sx * w;
      a.sepy += sy * w;
    }
    if (velTeam[j * 4 + 2] !== teamI) continue;
    const ox = wrapDelta(xi, posHead[j * 4], arena.w); // self -> neighbour
    const oy = wrapDelta(yi, posHead[j * 4 + 1], arena.h);
    if (ox * ox + oy * oy > flockR2) continue;
    a.vx += velTeam[j * 4];
    a.vy += velTeam[j * 4 + 1];
    a.cx += ox;
    a.cy += oy;
    a.cnt += 1;
  }
  return a;
};

// CPU flock reference — brute O(n²) oracle mirroring flock.wgsl: omnidirectional
// separation over all ships + same-team align/cohere. Since the grid cell edge
// >= max(sepR,flockR), the GPU's 3×3 walk is a superset of these neighbours, so
// brute-vs-grid divergence is float-order noise only.
export const cpuFlock = (
  posHead: Float32Array,
  velTeam: Float32Array,
  n: number,
  arena: Arena,
  t: FlockTuning,
): Float32Array => {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const hdx = posHead[i * 4 + 2];
    const hdy = posHead[i * 4 + 3];
    const a = accumulateFlock(i, posHead, velTeam, n, arena, t);
    let fx = a.sepx * t.sepGain;
    let fy = a.sepy * t.sepGain;
    if (a.cnt > 0) {
      const [ahx, ahy] = normalize([a.vx / a.cnt, a.vy / a.cnt], [hdx, hdy]);
      fx += (ahx - hdx) * t.alignGain + (a.cx / a.cnt) * t.cohereGain;
      fy += (ahy - hdy) * t.alignGain + (a.cy / a.cnt) * t.cohereGain;
    }
    out[i * 2] = fx;
    out[i * 2 + 1] = fy;
  }
  return out;
};
