// Hull silhouette: derive a 2D top-down outline path for a ship class straight
// from the catalog geometry, so the codex glyphs never drift from the real
// hulls. Bakes the recipe to triangles (hull/bake.ts), projects them onto the
// XY plane (ship-local nose is +Y, +Z faces the viewer — exactly the gameplay
// plan view), rasterizes their union into an occupancy grid, traces the outer
// contour with marching squares, simplifies it (Ramer–Douglas–Peucker), and
// fits it into a square viewBox with the nose pointing up. Pure + memoized:
// no GPU, no DOM — safe to call from any React view.

import { assembleShipMesh } from "./bake";
import { RECIPES, type ShipClass } from "./catalog";

// Rasterization resolution across the hull's longer axis. Higher = crisper
// outline before simplification; 140 keeps sub-pixel steps at a 24px glyph.
const RES = 140;
const BORDER = 2; // empty grid margin so the traced loop always closes inside
const RDP_EPSILON = 0.9; // contour simplification tolerance, in grid cells

type Pt = readonly [number, number];

interface Tri2 {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// --- projection -------------------------------------------------------------
// Read baked positions (stride 9: pos3, normal3, rgb3) and drop Z. Faces that
// project to a sliver contribute no area to the union, so they're skipped.
const projectTris = (cls: ShipClass): Tri2[] => {
  const { data, vertexCount } = assembleShipMesh(RECIPES[cls]);
  const tris: Tri2[] = [];
  for (let v = 0; v + 3 <= vertexCount; v += 3) {
    const o = v * 9;
    const ax = data[o];
    const ay = data[o + 1];
    const bx = data[o + 9];
    const by = data[o + 10];
    const cx = data[o + 18];
    const cy = data[o + 19];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-7) continue;
    tris.push({ ax, ay, bx, by, cx, cy });
  }
  return tris;
};

const boundsOf = (pts: readonly Pt[]): Bounds => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
};

const triBounds = (tris: Tri2[]): Bounds =>
  boundsOf(
    tris.flatMap((t): Pt[] => [
      [t.ax, t.ay],
      [t.bx, t.by],
      [t.cx, t.cy],
    ]),
  );

const edgeSign = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => (px - bx) * (ay - by) - (ax - bx) * (py - by);

const pointInTri = (px: number, py: number, t: Tri2): boolean => {
  const d1 = edgeSign(px, py, t.ax, t.ay, t.bx, t.by);
  const d2 = edgeSign(px, py, t.bx, t.by, t.cx, t.cy);
  const d3 = edgeSign(px, py, t.cx, t.cy, t.ax, t.ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
};

// --- occupancy grid ---------------------------------------------------------
interface Grid {
  occ: Uint8Array;
  pw: number; // grid POINT counts (cells + 1 each axis)
  ph: number;
  minX: number;
  minY: number;
  cell: number;
}

// Grid point (i,j) sits at world (minX+(i-BORDER)·cell, minY+(j-BORDER)·cell).
const stampTri = (g: Grid, t: Tri2): void => {
  const { occ, pw, ph, minX, minY, cell } = g;
  const gi = (w: number) => (w - minX) / cell + BORDER;
  const gj = (w: number) => (w - minY) / cell + BORDER;
  const i0 = Math.max(0, Math.floor(gi(Math.min(t.ax, t.bx, t.cx))));
  const i1 = Math.min(pw - 1, Math.ceil(gi(Math.max(t.ax, t.bx, t.cx))));
  const j0 = Math.max(0, Math.floor(gj(Math.min(t.ay, t.by, t.cy))));
  const j1 = Math.min(ph - 1, Math.ceil(gj(Math.max(t.ay, t.by, t.cy))));
  for (let j = j0; j <= j1; j++) {
    const wy = minY + (j - BORDER) * cell;
    for (let i = i0; i <= i1; i++) {
      const idx = j * pw + i;
      if (occ[idx]) continue;
      if (pointInTri(minX + (i - BORDER) * cell, wy, t)) occ[idx] = 1;
    }
  }
};

const rasterize = (tris: Tri2[]): Grid => {
  const b = triBounds(tris);
  const cell = Math.max(b.maxX - b.minX, b.maxY - b.minY) / RES || 1;
  const pw = Math.ceil((b.maxX - b.minX) / cell) + 2 * BORDER + 1;
  const ph = Math.ceil((b.maxY - b.minY) / cell) + 2 * BORDER + 1;
  const g: Grid = {
    occ: new Uint8Array(pw * ph),
    pw,
    ph,
    minX: b.minX,
    minY: b.minY,
    cell,
  };
  for (const t of tris) stampTri(g, t);
  return g;
};

// --- marching squares -------------------------------------------------------
// Emit boundary segments between the midpoints of grid-cell edges, keyed by
// doubled-integer coordinates (unique per shared edge) so segments from
// adjacent cells link up exactly. Then walk the graph into closed loops.

// Per case (bl|br<<1|tr<<2|tl<<3), the edge pairs to connect.
// Edges: 0 bottom, 1 right, 2 top, 3 left.
const CASES: readonly (readonly [number, number][])[] = [
  [], // 0
  [[3, 0]], // 1 bl
  [[0, 1]], // 2 br
  [[3, 1]], // 3 bl+br
  [[1, 2]], // 4 tr
  [
    [3, 0],
    [1, 2],
  ], // 5 bl+tr (ambiguous)
  [[0, 2]], // 6 br+tr
  [[3, 2]], // 7 bl+br+tr
  [[2, 3]], // 8 tl
  [[2, 0]], // 9 bl+tl
  [
    [0, 1],
    [2, 3],
  ], // 10 br+tl (ambiguous)
  [[2, 1]], // 11 bl+br+tl
  [[1, 3]], // 12 tr+tl
  [[1, 0]], // 13 bl+tr+tl
  [[0, 3]], // 14 br+tr+tl
  [], // 15
];

// Doubled-int coord of a cell edge midpoint (shared between neighbours).
const edgeKey = (i: number, j: number, edge: number): string => {
  switch (edge) {
    case 0:
      return `${2 * i + 1},${2 * j}`; // bottom
    case 1:
      return `${2 * i + 2},${2 * j + 1}`; // right
    case 2:
      return `${2 * i + 1},${2 * j + 2}`; // top
    default:
      return `${2 * i},${2 * j + 1}`; // left
  }
};

type Adjacency = Map<string, string[]>;

const buildAdjacency = (g: Grid): Adjacency => {
  const occ = (i: number, j: number) => g.occ[j * g.pw + i];
  const adj: Adjacency = new Map();
  const push = (k: string, v: string) => {
    const arr = adj.get(k);
    if (arr) arr.push(v);
    else adj.set(k, [v]);
  };
  for (let j = 0; j < g.ph - 1; j++) {
    for (let i = 0; i < g.pw - 1; i++) {
      const code =
        occ(i, j) |
        (occ(i + 1, j) << 1) |
        (occ(i + 1, j + 1) << 2) |
        (occ(i, j + 1) << 3);
      for (const [ea, eb] of CASES[code]) {
        const ka = edgeKey(i, j, ea);
        const kb = edgeKey(i, j, eb);
        push(ka, kb);
        push(kb, ka);
      }
    }
  }
  return adj;
};

// Walk from `start` following unused edges until the loop closes back.
const walkLoop = (adj: Adjacency, start: string, seen: Set<string>): Pt[] => {
  const loop: Pt[] = [];
  let cur = start;
  let prev = "";
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const [x, y] = cur.split(",").map(Number);
    loop.push([x, y]);
    const next = (adj.get(cur) ?? []).find((n) => n !== prev);
    if (!next) break;
    prev = cur;
    cur = next;
  }
  return loop;
};

const marchLoops = (g: Grid): Pt[][] => {
  const adj = buildAdjacency(g);
  const loops: Pt[][] = [];
  const seen = new Set<string>();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop = walkLoop(adj, start, seen);
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
};

// --- simplify ---------------------------------------------------------------
const perpDist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
};

const rdp = (pts: Pt[], eps: number): Pt[] => {
  if (pts.length < 3) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return [...left.slice(0, -1), ...right];
};

// Longest closed loop = the union's outer boundary.
const pickOuter = (loops: Pt[][]): Pt[] => {
  let outer: Pt[] = [];
  for (const l of loops) if (l.length > outer.length) outer = l;
  return outer;
};

// Rotate the contour to a deterministic start (top-most, then left-most) so
// simplification is stable across runs.
const rotateToStart = (pts: Pt[]): Pt[] => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const c = pts[s];
    if (p[1] < c[1] || (p[1] === c[1] && p[0] < c[0])) s = i;
  }
  return [...pts.slice(s), ...pts.slice(0, s)];
};

// Fit contour (grid-cell coords) into `size`×`size`, uniform-scaled + centered,
// flipping Y so +Y (nose) points up. Emits an SVG path with a closing Z.
const emitPath = (pts: Pt[], size: number): string => {
  const b = boundsOf(pts);
  const margin = size * 0.08;
  const span = size - 2 * margin;
  const w = b.maxX - b.minX || 1;
  const h = b.maxY - b.minY || 1;
  const scale = span / Math.max(w, h);
  const offX = margin + (span - w * scale) / 2;
  const offY = margin + (span - h * scale) / 2;
  const r = (n: number) => Math.round(n * 10) / 10;
  const sx = (x: number) => r(offX + (x - b.minX) * scale);
  const sy = (y: number) => r(size - offY - (y - b.minY) * scale);
  const d = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${sx(x)} ${sy(y)}`)
    .join(" ");
  return `${d} Z`;
};

// --- public api -------------------------------------------------------------
const cache = new Map<string, string>();

/**
 * Top-down silhouette outline of a hull class as an SVG path string, fitted
 * into `size`×`size` with the nose pointing up. Cached per (class, size).
 */
export const hullSilhouettePath = (cls: ShipClass, size = 24): string => {
  const key = `${cls}@${size}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const outer = pickOuter(marchLoops(rasterize(projectTris(cls))));
  if (outer.length < 3) {
    cache.set(key, "");
    return "";
  }
  // Doubled edge coords → cell coords, then simplify the open polyline (Z
  // reconnects the ends — closing it here would zero RDP's base segment).
  const cellPts = rotateToStart(outer.map(([x, y]): Pt => [x / 2, y / 2]));
  const path = emitPath(rdp(cellPts, RDP_EPSILON), size);
  cache.set(key, path);
  return path;
};
