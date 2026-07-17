// CPU broad-phase — candidate-pair enumeration for the O(n²) collision resolvers.
// A resolver keeps the authoritative LIVE narrow-phase (exact per-pair distance +
// mutation); this only decides which pairs to CONSIDER, emitted in the same order
// the nested double-loop visits them (lexicographic by index). So swapping the
// brute nested loop for a broad-phase list changes cost, never behaviour.
//
// The cell scheme mirrors the GPU `SpatialGrid` (src/gpgpu): cell edge =
// arena/floor(arena/band) ≥ band, a 3×3 toroidal block is a conservative superset
// of every neighbour within `band`, and ≥3 cells/axis are required (else the
// toroidal 3×3 wraps onto itself). A GPU-produced pair list is therefore a
// drop-in replacement for `gridSelfPairs` once the async plumbing lands.

import { toroidalDist } from "~/engine/physics";

export interface Pt {
  x: number;
  y: number;
}

// Flat, lexicographically-sorted candidate pairs: [i0, j0, i1, j1, …], j > i.
export type PairList = Int32Array;

// Ship-pair candidate band (px). The ship×ship narrow-phase gate is the semitouch
// radius (22px); the extra margin covers intra-tick bounce drift (a ship can be
// nudged by hull separation between the snapshot and its collision turn), keeping
// the snapshot grid a conservative superset of every pair the live gate accepts.
// Validated bit-identical against the nested loop in broadphase.test.
export const SHIP_PAIR_BAND = 64;

interface Grid {
  ncx: number;
  ncy: number;
  cellW: number;
  cellH: number;
}

const wrapCell = (c: number, n: number): number => ((c % n) + n) % n;

// Grid dims, or null when the arena is smaller than 3 cells/axis at this band (the
// toroidal 3×3 would wrap onto itself). Every grid builder returns null here so
// its caller falls back to the brute loop — a narrow/portrait viewport shrinks
// the arena width, so this must never throw on the live render path.
function tryCellDims(w: number, h: number, band: number): Grid | null {
  const ncx = Math.floor(w / band);
  const ncy = Math.floor(h / band);
  return ncx < 3 || ncy < 3
    ? null
    : { ncx, ncy, cellW: w / ncx, cellH: h / ncy };
}

const cellXOf = (x: number, g: Grid): number =>
  Math.min((x / g.cellW) | 0, g.ncx - 1);
const cellYOf = (y: number, g: Grid): number =>
  Math.min((y / g.cellH) | 0, g.ncy - 1);

// The nine flat cell indices of a point's 3×3 toroidal block (its own cell + 8
// wrapped neighbours). Kept ≤10 cognitive complexity by flattening the 3×3 walk.
function neighborCells(cx: number, cy: number, g: Grid): number[] {
  const cells: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    const gy = wrapCell(cy + dy, g.ncy);
    for (let dx = -1; dx <= 1; dx++)
      cells.push(gy * g.ncx + wrapCell(cx + dx, g.ncx));
  }
  return cells;
}

// Emit i paired with every higher-index neighbour within `band` (j > i keeps each
// unordered pair once). Extracted so `gridSelfPairs` stays under the complexity cap.
function emitSelfPairs(
  i: number,
  pts: readonly Pt[],
  buckets: number[][],
  g: Grid,
  arena: { w: number; h: number },
  band2: number,
  out: number[],
): void {
  const p = pts[i];
  const cells = neighborCells(cellXOf(p.x, g), cellYOf(p.y, g), g);
  for (const c of cells) {
    for (const j of buckets[c]) {
      if (j <= i) continue;
      const ex = toroidalDist(p.x, pts[j].x, arena.w);
      const ey = toroidalDist(p.y, pts[j].y, arena.h);
      if (ex * ex + ey * ey < band2) out.push(i, j);
    }
  }
}

// Sort a flat pair array in place by the key (i·n + j) — unique per (i,j), so the
// order is fully determined regardless of emission order (deterministic).
function sortPairs(flat: number[], n: number): PairList {
  const m = flat.length / 2;
  const order = Array.from({ length: m }, (_, k) => k);
  order.sort(
    (a, b) =>
      flat[a * 2] * n + flat[a * 2 + 1] - (flat[b * 2] * n + flat[b * 2 + 1]),
  );
  const out = new Int32Array(m * 2);
  for (let k = 0; k < m; k++) {
    out[k * 2] = flat[order[k] * 2];
    out[k * 2 + 1] = flat[order[k] * 2 + 1];
  }
  return out;
}

// Grid-accelerated self-pairing (ship×ship): emit candidate index pairs (i,j),
// j > i, within `band` on the given snapshot positions, sorted lexicographically.
// Each unordered pair is emitted exactly once (only i's walk that finds j>i keeps
// it), so no dedup pass is needed. Returns null when the arena is too small to
// grid (< 3 cells/axis at this band, e.g. a narrow/portrait window) — the caller
// then falls back to the brute nested loop. (empty array = gridded, zero pairs.)
export function gridSelfPairs(
  pts: readonly Pt[],
  arena: { w: number; h: number },
  band: number,
): PairList | null {
  const n = pts.length;
  if (n < 2) return new Int32Array(0);
  const g = tryCellDims(arena.w, arena.h, band);
  if (!g) return null;
  const buckets: number[][] = Array.from({ length: g.ncx * g.ncy }, () => []);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    buckets[cellYOf(p.y, g) * g.ncx + cellXOf(p.x, g)].push(i);
  }

  const band2 = band * band;
  const out: number[] = [];
  for (let i = 0; i < n; i++)
    emitSelfPairs(i, pts, buckets, g, arena, band2, out);
  return sortPairs(out, n);
}

// Brute O(n²) self-pairing oracle: every pair (i,j), j > i, within `band`, in
// lexicographic order. The reference `gridSelfPairs` is validated against.
export function bruteSelfPairs(
  pts: readonly Pt[],
  arena: { w: number; h: number },
  band: number,
): PairList {
  const n = pts.length;
  const band2 = band * band;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ex = toroidalDist(pts[i].x, pts[j].x, arena.w);
      const ey = toroidalDist(pts[i].y, pts[j].y, arena.h);
      if (ex * ex + ey * ey < band2) out.push(i, j);
    }
  }
  return new Int32Array(out); // already lexicographic
}

// --- cross-set pairing (two disjoint sets, e.g. bullets × ships) — mirrors the
// GPU CrossPairKernel (P6). The grid is built over set A (the inner/scan set); B
// elements query it. No j>i dedup (the sets are disjoint). Pairs are emitted
// (bIdx, aIdx) and sorted by (bIdx·nA + aIdx) — i.e. grouped by B, aIdx ascending
// — so `runCrossPairs` replays a nested `for b { for a }` loop's first-hit order.

// Emit b paired with every A-element within `band`. Extracted to stay under the
// cognitive-complexity cap.
function emitCrossPairs(
  bi: number,
  ptsB: readonly Pt[],
  ptsA: readonly Pt[],
  bucketsA: number[][],
  g: Grid,
  arena: { w: number; h: number },
  band2: number,
  out: number[],
): void {
  const p = ptsB[bi];
  const cells = neighborCells(cellXOf(p.x, g), cellYOf(p.y, g), g);
  for (const c of cells) {
    for (const ai of bucketsA[c]) {
      const ex = toroidalDist(p.x, ptsA[ai].x, arena.w);
      const ey = toroidalDist(p.y, ptsA[ai].y, arena.h);
      if (ex * ex + ey * ey < band2) out.push(bi, ai);
    }
  }
}

// Grid-accelerated cross pairing: candidate (bIdx, aIdx) pairs within `band`,
// grouped by bIdx with aIdx ascending. `band` must cover the widest per-pair hit
// radius so the list stays a superset of what the resolver's narrow-phase accepts.
// Returns null when the arena is too small to grid at this band → caller brutes.
export function gridCrossPairs(
  ptsB: readonly Pt[],
  ptsA: readonly Pt[],
  arena: { w: number; h: number },
  band: number,
): PairList | null {
  const nA = ptsA.length;
  const nB = ptsB.length;
  if (nA === 0 || nB === 0) return new Int32Array(0);
  const g = tryCellDims(arena.w, arena.h, band);
  if (!g) return null;
  const buckets: number[][] = Array.from({ length: g.ncx * g.ncy }, () => []);
  for (let a = 0; a < nA; a++) {
    const p = ptsA[a];
    buckets[cellYOf(p.y, g) * g.ncx + cellXOf(p.x, g)].push(a);
  }

  const band2 = band * band;
  const out: number[] = [];
  for (let b = 0; b < nB; b++)
    emitCrossPairs(b, ptsB, ptsA, buckets, g, arena, band2, out);
  return sortPairs(out, nA);
}

// Brute cross oracle: every (b, a) within `band`, b-major then a ascending —
// already in the (b·nA + a) order `gridCrossPairs` sorts to.
export function bruteCrossPairs(
  ptsB: readonly Pt[],
  ptsA: readonly Pt[],
  arena: { w: number; h: number },
  band: number,
): PairList {
  const band2 = band * band;
  const out: number[] = [];
  for (let b = 0; b < ptsB.length; b++) {
    for (let a = 0; a < ptsA.length; a++) {
      const ex = toroidalDist(ptsB[b].x, ptsA[a].x, arena.w);
      const ey = toroidalDist(ptsB[b].y, ptsA[a].y, arena.h);
      if (ex * ex + ey * ey < band2) out.push(b, a);
    }
  }
  return new Int32Array(out);
}

// Replay a cross candidate list grouped by B in ascending-A order, calling
// `onPair(bIdx, aIdx)`. A truthy return stops that B's run (mirrors the nested
// loop's break-on-first-hit) while remaining B groups continue.
export function runCrossPairs(
  pairs: PairList,
  onPair: (bi: number, ai: number) => boolean,
): void {
  let k = 0;
  while (k < pairs.length) {
    const b = pairs[k];
    const stop = onPair(b, pairs[k + 1]);
    k += 2;
    if (stop) while (k < pairs.length && pairs[k] === b) k += 2;
  }
}

// --- per-element neighbour lists (for per-ship query/force terms — flockSteer's
// separation/align/cohere/pickFoe). Unlike the pair enumerators this is consumed
// as "for each i, its neighbours", the P3 accumulation shape. Neighbours come in
// ASCENDING index order (a subsequence of the full array's order), so any
// order-sensitive float accumulation over them stays bit-identical to iterating
// the full array with the same per-element distance gate.

// The ascending-index neighbours of i within `band` (i itself excluded).
function collectNeighbors(
  i: number,
  pts: readonly Pt[],
  buckets: number[][],
  g: Grid,
  arena: { w: number; h: number },
  band2: number,
): number[] {
  const p = pts[i];
  const cells = neighborCells(cellXOf(p.x, g), cellYOf(p.y, g), g);
  const out: number[] = [];
  for (const c of cells) {
    for (const j of buckets[c]) {
      if (j === i) continue;
      const ex = toroidalDist(p.x, pts[j].x, arena.w);
      const ey = toroidalDist(p.y, pts[j].y, arena.h);
      if (ex * ex + ey * ey < band2) out.push(j);
    }
  }
  return out.sort((a, b) => a - b); // ascending → subsequence of full-array order
}

// For every point, its neighbour indices within `band`. Returns null when the
// arena is too small to grid (< 3 cells/axis) — the caller then keeps the brute
// full-array scan (correct, just O(n²)). This is the ONE band for all flock terms
// (= max engage radius); each term re-gates to its own smaller radius.
export function gridNeighbors(
  pts: readonly Pt[],
  arena: { w: number; h: number },
  band: number,
): number[][] | null {
  const g = tryCellDims(arena.w, arena.h, band);
  if (!g) return null;
  const n = pts.length;
  const buckets: number[][] = Array.from({ length: g.ncx * g.ncy }, () => []);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    buckets[cellYOf(p.y, g) * g.ncx + cellXOf(p.x, g)].push(i);
  }
  const band2 = band * band;
  const out: number[][] = new Array(n);
  for (let i = 0; i < n; i++)
    out[i] = collectNeighbors(i, pts, buckets, g, arena, band2);
  return out;
}
