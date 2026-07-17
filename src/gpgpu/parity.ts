// Parity harness: the CPU reference for each ported kernel plus a diff. The CPU
// path is authoritative (it is what `bun test` exercises — no GPU there), so
// every kernel is validated against it. The check is PLAUSIBLE-divergence, not
// bit-exact: GPU floats differ from JS (Metal sqrt/div, non-associativity), so
// we assert relative error stays under a gameplay-safe threshold, not zero.

import { normalize, wrapDelta } from "~/engine/physics";
import type { FlockTuning } from "~/gpgpu/kernels/flock";
import type { Arena } from "~/gpgpu/kernels/separation";
import {
  ARCHETYPE_MODS,
  CONCAVE_COMMIT_DIST,
  CONCAVE_GAIN,
  COORDINATE_MIN_LEVEL,
  combatAggression,
  ENGAGE_GAIN,
  ENGAGE_RADIUS,
  isRammer,
  KITE_DIST,
  maxHpForLevel,
  targetPriority,
} from "~/world/tuning";
import { ARCHETYPES, type Archetype, type LightCycle } from "~/world/types";

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

// --- Pursuit parity (per-ship foe reduction + steering) ---------------------

// Deterministic combat field: posHead [x,y,dx,dy], combat [team,level,arch,id],
// health [hp,maxHp,fuel,maxFuel]. Teams/levels/archetypes span the full range so
// the reduction exercises focus vs nearest, counters, and aggression scaling.
export const makePursuitField = (
  n: number,
  arena: Arena,
  seed = 0x9e37,
): { posHead: Float32Array; combat: Float32Array; health: Float32Array } => {
  let s = seed ^ n;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const posHead = new Float32Array(n * 4);
  const combat = new Float32Array(n * 4);
  const health = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    posHead[i * 4] = rnd() * arena.w;
    posHead[i * 4 + 1] = rnd() * arena.h;
    posHead[i * 4 + 2] = Math.cos(a);
    posHead[i * 4 + 3] = Math.sin(a);
    const level = 1 + Math.floor(rnd() * 5); // 1..5
    const maxHp = maxHpForLevel(level);
    const maxFuel = 400 + Math.floor(rnd() * 400);
    combat[i * 4] = Math.floor(rnd() * NUM_TEAMS); // team
    combat[i * 4 + 1] = level;
    combat[i * 4 + 2] = Math.floor(rnd() * ARCHETYPES.length); // archetype
    combat[i * 4 + 3] = i; // id
    health[i * 4] = (0.2 + rnd() * 0.8) * maxHp; // hp
    health[i * 4 + 1] = maxHp;
    health[i * 4 + 2] = rnd() * maxFuel; // fuel
    health[i * 4 + 3] = maxFuel;
  }
  return { posHead, combat, health };
};

// A LightCycle-lite view over the SoA at index i — only the fields the ported
// tuning functions (targetPriority / combatAggression / isRammer / counters)
// actually read, so the oracle drives the REAL tuning code (not a copy of it).
const shipAt = (
  i: number,
  posHead: Float32Array,
  combat: Float32Array,
  health: Float32Array,
): LightCycle =>
  ({
    id: combat[i * 4 + 3],
    x: posHead[i * 4],
    y: posHead[i * 4 + 1],
    dx: posHead[i * 4 + 2],
    dy: posHead[i * 4 + 3],
    colorName: String(combat[i * 4]),
    level: combat[i * 4 + 1],
    archetype: ARCHETYPES[combat[i * 4 + 2]] as Archetype,
    hp: health[i * 4],
    maxHp: health[i * 4 + 1],
    fuel: health[i * 4 + 2],
    maxFuel: health[i * 4 + 3],
  }) as unknown as LightCycle;

type PFoe = { ex: number; ey: number; d2: number; ship: LightCycle };

const beatsFoe = (
  focus: boolean,
  p: number,
  d2: number,
  bestP: number,
  bestD2: number,
): boolean => (focus ? p > bestP || (p === bestP && d2 < bestD2) : d2 < bestD2);

// Clone of pickFoe (steering.ts): the winning enemy within rangeSq for `self`.
const pickFoePar = (
  self: LightCycle,
  ships: readonly LightCycle[],
  rangeSq: number,
  focus: boolean,
  arena: Arena,
): PFoe | null => {
  let ex = 0;
  let ey = 0;
  let bestP = Number.NEGATIVE_INFINITY;
  let bestD2 = rangeSq;
  let ship: LightCycle | null = null;
  for (const o of ships) {
    if (o.id === self.id || o.colorName === self.colorName) continue;
    const dx = wrapDelta(self.x, o.x, arena.w);
    const dy = wrapDelta(self.y, o.y, arena.h);
    const d2 = dx * dx + dy * dy;
    const p = targetPriority(o);
    if (d2 >= rangeSq || !beatsFoe(focus, p, d2, bestP, bestD2)) continue;
    bestP = p;
    bestD2 = d2;
    ex = dx;
    ey = dy;
    ship = o;
  }
  return ship ? { ex, ey, d2: bestD2, ship } : null;
};

// Clone of steerPursuit (steering.ts) — press/kite/concave/aggression.
const pursuitForcePar = (self: LightCycle, foe: PFoe): [number, number] => {
  const level = self.level;
  const engageGain = ENGAGE_GAIN[level - 1] ?? 0;
  if (engageGain <= 0) return [0, 0];
  const press =
    isRammer(self.archetype) ||
    ARCHETYPE_MODS[self.archetype].counters === foe.ship.archetype;
  const kiteDist = press ? 0 : (KITE_DIST[level - 1] ?? 0);
  const aggro = combatAggression(self, foe.ship);
  const dist = Math.sqrt(foe.d2) || 1;
  const ux = foe.ex / dist;
  const uy = foe.ey / dist;
  const dir = kiteDist > 0 ? Math.sign(dist - kiteDist) : 1;
  const side = self.id % 2 === 0 ? 1 : -1;
  const arc = press
    ? CONCAVE_GAIN * side * Math.min(1, dist / CONCAVE_COMMIT_DIST)
    : 0;
  const tx = ux * dir - uy * arc;
  const ty = uy * dir + ux * arc;
  return [tx * engageGain * aggro, ty * engageGain * aggro];
};

// CPU pursuit reference — brute O(n^2) mirror of pickFoe + steerPursuit over the
// SoA field. Authoritative oracle for PursuitKernel.
export const cpuPursuit = (
  posHead: Float32Array,
  combat: Float32Array,
  health: Float32Array,
  n: number,
  arena: Arena,
): Float32Array => {
  const ships: LightCycle[] = [];
  for (let i = 0; i < n; i++) ships.push(shipAt(i, posHead, combat, health));
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const self = ships[i];
    const engageR = ENGAGE_RADIUS[self.level - 1] ?? 0;
    const focus =
      isRammer(self.archetype) || self.level >= COORDINATE_MIN_LEVEL;
    const foe =
      engageR > 0
        ? pickFoePar(self, ships, engageR * engageR, focus, arena)
        : null;
    if (!foe) continue;
    const [fx, fy] = pursuitForcePar(self, foe);
    out[i * 2] = fx;
    out[i * 2 + 1] = fy;
  }
  return out;
};

// --- Candidate-pair parity (P5 hybrid broad-phase) --------------------------

export interface Pairs {
  count: number;
  pairs: Uint32Array; // flat [i0,j0,i1,j1,...] in (i,j) lexicographic order
}

// CPU brute broad-phase oracle: every ordered pair (i<j) whose toroidal distance
// is within `r`. Emits pairs in (i,j) lexicographic order — the exact visit order
// resolveShipCollisions uses — so the GPU list (once sorted) replays identically.
// Uses wrapDelta components (|wrapDelta| == toroidalDist), matching pairs.wgsl.
export const cpuCandidatePairs = (
  positions: Float32Array,
  n: number,
  arena: Arena,
  r: number,
): Pairs => {
  const r2 = r * r;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const xi = positions[i * 4];
    const yi = positions[i * 4 + 1];
    for (let j = i + 1; j < n; j++) {
      const dx = wrapDelta(xi, positions[j * 4], arena.w);
      const dy = wrapDelta(yi, positions[j * 4 + 1], arena.h);
      if (dx * dx + dy * dy < r2) out.push(i, j);
    }
  }
  return { count: out.length / 2, pairs: Uint32Array.from(out) };
};

// CPU brute cross-set oracle: every pair (bIdx, aIdx) whose toroidal distance is
// within `r`, in (b,a) lexicographic order. B queries A (bullets vs ships). Same
// wrapDelta components as cross.wgsl.
export const cpuCrossPairs = (
  posB: Float32Array,
  posA: Float32Array,
  nB: number,
  nA: number,
  arena: Arena,
  r: number,
): Pairs => {
  const r2 = r * r;
  const out: number[] = [];
  for (let b = 0; b < nB; b++) {
    const xb = posB[b * 4];
    const yb = posB[b * 4 + 1];
    for (let a = 0; a < nA; a++) {
      const dx = wrapDelta(xb, posA[a * 4], arena.w);
      const dy = wrapDelta(yb, posA[a * 4 + 1], arena.h);
      if (dx * dx + dy * dy < r2) out.push(b, a);
    }
  }
  return { count: out.length / 2, pairs: Uint32Array.from(out) };
};

// Sort a flat pair list into (i,j) lexicographic order (GPU appends in atomic-
// cursor order, which is device-nondeterministic).
const sortPairs = (flat: Uint32Array, n: number): number[] => {
  const keys: number[] = [];
  for (let k = 0; k < flat.length; k += 2) keys.push(flat[k] * n + flat[k + 1]);
  return keys.sort((a, b) => a - b);
};

// Set-equality of two candidate-pair lists (order-independent). The CPU list is
// the oracle; the GPU list must contain exactly the same pairs.
export const comparePairs = (
  cpu: Pairs,
  gpu: Uint32Array,
  n: number,
): { match: boolean; cpuCount: number; gpuCount: number } => {
  const a = sortPairs(cpu.pairs, n);
  const b = sortPairs(gpu, n);
  let match = a.length === b.length;
  for (let k = 0; match && k < a.length; k++) if (a[k] !== b[k]) match = false;
  return { match, cpuCount: a.length, gpuCount: b.length };
};
