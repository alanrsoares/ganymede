// Hull baking: turns catalog recipes (plain `PartDef` data) into mesh-pass
// geometry — a small kit of faceted convex prims, an assembler that bakes
// flat-shaded vertex-coloured triangles (values > 1 mark emissive surfaces
// the shader lets bloom), the engine plume cone, and ray picking for the
// drydock editor. Built once on CPU (like mesh.ts) and instanced per ship.

import type { Mesh } from "~/render/mesh";
import {
  PALETTE,
  type PartDef,
  type PrimDef,
  RECIPES,
  type ShipClass,
  type V3,
} from "./catalog";

type Tri = [V3, V3, V3];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// --- convex primitives -------------------------------------------------------
// Each returns verts + faces; winding is irrelevant because the assembler
// re-orients every face normal outward from the part centre (all parts are
// convex, so "away from centre" is always the outside).

interface Prim {
  verts: V3[];
  faces: [number, number, number][];
}

/**
 * Tapered box (frustum) along Y: base quad at y=-0.5 with half-extents 0.5,
 * nose quad at y=+0.5 scaled by (tx, tz). tx=tz=1 is a box; near-zero tapers
 * to a spike. The workhorse: hull masses, plates, fins, fangs.
 */
const slab = (tx: number, tz: number): Prim => {
  const verts: V3[] = [];
  for (const sy of [-0.5, 0.5]) {
    const hx = 0.5 * (sy > 0 ? tx : 1);
    const hz = 0.5 * (sy > 0 ? tz : 1);
    verts.push([-hx, sy, -hz], [hx, sy, -hz], [hx, sy, hz], [-hx, sy, hz]);
  }
  const faces: [number, number, number][] = [];
  const quad = (a: number, b: number, c: number, d: number) =>
    faces.push([a, b, c], [a, c, d]);
  quad(0, 1, 2, 3);
  quad(4, 5, 6, 7);
  quad(0, 1, 5, 4);
  quad(1, 2, 6, 5);
  quad(2, 3, 7, 6);
  quad(3, 0, 4, 7);
  return { verts, faces };
};

/** Octagonal cross-section ring at height y: a box section with corners cut c. */
const octRing = (verts: V3[], y: number, hx: number, hz: number, c: number) => {
  const cx = Math.min(c, hx * 0.9);
  const cz = Math.min(c, hz * 0.9);
  verts.push(
    [hx - cx, y, -hz],
    [hx, y, -hz + cz],
    [hx, y, hz - cz],
    [hx - cx, y, hz],
    [-(hx - cx), y, hz],
    [-hx, y, hz - cz],
    [-hx, y, -hz + cz],
    [-(hx - cx), y, -hz],
  );
};

/**
 * Chamfered slab: the same frustum as `slab`, but the four long edges are cut
 * to an octagonal section and the base/nose rims are chamfered in. Still
 * convex, every facet flat — the chamfers exist to catch the key light so a
 * hull mass reads as machined carapace instead of a box. `bevel` is the cut
 * width in unit space (useful range ≈ 0.04–0.2).
 */
const bevelSlab = (tx: number, tz: number, bevel: number): Prim => {
  const c = Math.min(Math.max(bevel, 0.01), 0.24);
  const ext = (y: number): [number, number] => {
    const t = y + 0.5;
    return [0.5 * (1 + (tx - 1) * t), 0.5 * (1 + (tz - 1) * t)];
  };
  const verts: V3[] = [];
  const ys = [-0.5, -0.5 + c, 0.5 - c, 0.5];
  ys.forEach((y, i) => {
    const [hx, hz] = ext(y);
    const rim = i === 0 || i === 3 ? c : 0;
    octRing(verts, y, Math.max(hx - rim, 0.02), Math.max(hz - rim, 0.02), c);
  });
  const faces: [number, number, number][] = [];
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      const a = r * 8 + i;
      const b = r * 8 + j;
      faces.push([a, b, b + 8], [a, b + 8, a + 8]);
    }
  }
  for (let i = 1; i < 7; i++) {
    faces.push([0, i, i + 1], [24, 24 + i, 24 + i + 1]);
  }
  return { verts, faces };
};

/** Tapered hex prism along Y — engine polyps, barrels, pods, eye stalks. */
const hexPrism = (taper: number): Prim => {
  const verts: V3[] = [];
  for (const sy of [-0.5, 0.5]) {
    const r = 0.5 * (sy > 0 ? taper : 1);
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      verts.push([Math.cos(a) * r, sy, Math.sin(a) * r]);
    }
  }
  const faces: [number, number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    faces.push([i, j, 6 + j], [i, 6 + j, 6 + i]);
  }
  for (let i = 1; i < 5; i++) {
    faces.push([0, i, i + 1], [6, 6 + i, 6 + i + 1]);
  }
  return { verts, faces };
};

/** Faceted eye orb: octahedron subdivided once — 32 faces, reads round. */
const orb = (): Prim => {
  let verts: V3[] = [
    [0, 0.5, 0],
    [0, -0.5, 0],
    [0.5, 0, 0],
    [-0.5, 0, 0],
    [0, 0, 0.5],
    [0, 0, -0.5],
  ];
  let faces: [number, number, number][] = [
    [0, 2, 4],
    [0, 4, 3],
    [0, 3, 5],
    [0, 5, 2],
    [1, 4, 2],
    [1, 3, 4],
    [1, 5, 3],
    [1, 2, 5],
  ];
  // One subdivision, midpoints pushed to the r=0.5 sphere.
  const mid = new Map<string, number>();
  const gm = (a: number, b: number): number => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    const hit = mid.get(k);
    if (hit !== undefined) return hit;
    const p = norm([
      verts[a][0] + verts[b][0],
      verts[a][1] + verts[b][1],
      verts[a][2] + verts[b][2],
    ]);
    mid.set(k, verts.length);
    verts.push([p[0] * 0.5, p[1] * 0.5, p[2] * 0.5]);
    return verts.length - 1;
  };
  const out: [number, number, number][] = [];
  for (const [a, b, c] of faces) {
    const ab = gm(a, b);
    const bc = gm(b, c);
    const ca = gm(c, a);
    out.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  faces = out;
  verts = verts.map((v) => {
    const n = norm(v);
    return [n[0] * 0.5, n[1] * 0.5, n[2] * 0.5];
  });
  return { verts, faces };
};

export const buildPrim = (def: PrimDef): Prim => {
  switch (def.kind) {
    case "slab":
      return def.bevel && def.bevel > 0
        ? bevelSlab(def.tx, def.tz, def.bevel)
        : slab(def.tx, def.tz);
    case "hex":
      return hexPrism(def.taper);
    case "orb":
      return orb();
  }
};

// --- assembler ----------------------------------------------------------------

const rotMat = ([ax, ay, az]: V3): number[] => {
  const cx = Math.cos(ax);
  const sx = Math.sin(ax);
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  const cz = Math.cos(az);
  const sz = Math.sin(az);
  // Rz * Ry * Rx, row-major.
  return [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    -sy,
    cy * sx,
    cy * cx,
  ];
};
const mulV = (m: number[], v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

// --- centipede segmentation ----------------------------------------------------
// A part with seg > 1 bakes as a chain of overlapping carapace plates along
// its local Y. Each plate keeps the part's silhouette (its cross-section
// follows the original taper), its nose tucks under the next plate's base so
// joints read as telescoped shell, and the short span lets the spine wave
// (ship.wgsl spineDeform) tilt each plate near-rigidly — a long prim only has
// vertices at its ends, so the wave would just shear it.

const PLATE_OVERLAP = 1.5; // plate height ÷ pitch — joints stay sealed mid-bend
const PLATE_TUCK = 0.85; // extra nose taper so each plate nests into the next

const expandSeg = (def: PartDef): PartDef[] => {
  const n = Math.round(def.seg ?? 1);
  if (n <= 1 || def.prim.kind === "orb") return [def];
  const m = rotMat(def.rot ?? [0, 0, 0]);
  // Cross-section factor at t (0 base → 1 nose) of the original prim.
  const [nx, nz] =
    def.prim.kind === "slab"
      ? [def.prim.tx, def.prim.tz]
      : [def.prim.taper, def.prim.taper];
  const ext = (f: number, t: number): number => 1 + (f - 1) * t;
  const out: PartDef[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const tc = (t0 + t1) / 2;
    const off = mulV(m, [0, (tc - 0.5) * def.scale[1], 0]);
    const bx = ext(nx, t0);
    const bz = ext(nz, t0);
    const tx = (ext(nx, t1) / bx) * PLATE_TUCK;
    const tz = (ext(nz, t1) / bz) * PLATE_TUCK;
    out.push({
      ...def,
      seg: 1,
      prim:
        def.prim.kind === "slab"
          ? { ...def.prim, tx, tz }
          : { kind: "hex", taper: tx },
      scale: [
        def.scale[0] * bx,
        (def.scale[1] / n) * PLATE_OVERLAP,
        def.scale[2] * bz,
      ],
      pos: [def.pos[0] + off[0], def.pos[1] + off[1], def.pos[2] + off[2]],
    });
  }
  return out;
};

/** Bake one part (and its optional mirror) into flat-shaded triangles. */
const bakePart = (def: PartDef, prim: Prim, out: Tri[], colors: V3[]): void => {
  const m = rotMat(def.rot ?? [0, 0, 0]);
  const col = PALETTE[def.color];
  for (const mx of def.mirror ? [1, -1] : [1]) {
    const centre: V3 = [def.pos[0] * mx, def.pos[1], def.pos[2]];
    const verts = prim.verts.map((v): V3 => {
      const s = mulV(m, [
        v[0] * def.scale[0],
        v[1] * def.scale[1],
        v[2] * def.scale[2],
      ]);
      return [s[0] * mx + centre[0], s[1] + centre[1], s[2] + centre[2]];
    });
    for (const [a, b, c] of prim.faces) {
      out.push([verts[a], verts[b], verts[c]]);
      colors.push(col);
    }
  }
};

/** Record each baked tri's part centre (mirror-aware) for the outward fix. */
const trackCentres = (def: PartDef, added: number, centres: V3[]): void => {
  const half = def.mirror ? added / 2 : added;
  for (let i = 0; i < added; i++) {
    const mx = def.mirror && i >= half ? -1 : 1;
    centres.push([def.pos[0] * mx, def.pos[1], def.pos[2]]);
  }
};

/**
 * Flat outward normal for a convex part's face: face normal flipped, when
 * needed, to point away from the part centre.
 */
const outwardNormal = (tri: Tri, centre: V3): V3 | null => {
  const [pa, pb, pc] = tri;
  const raw = cross(sub(pb, pa), sub(pc, pa));
  if (Math.hypot(raw[0], raw[1], raw[2]) < 1e-9) return null;
  const n = norm(raw);
  const cen: V3 = [
    (pa[0] + pb[0] + pc[0]) / 3,
    (pa[1] + pb[1] + pc[1]) / 3,
    (pa[2] + pb[2] + pc[2]) / 3,
  ];
  return dot(n, sub(cen, centre)) < 0 ? [-n[0], -n[1], -n[2]] : n;
};

/** Write one flat-shaded tri (pos, normal, rgb per vertex). Returns new offset. */
const writeTri = (
  data: Float32Array,
  o: number,
  tri: Tri,
  n: V3,
  col: V3,
): number => {
  let at = o;
  for (const p of tri) {
    data[at++] = p[0];
    data[at++] = p[1];
    data[at++] = p[2];
    data[at++] = n[0];
    data[at++] = n[1];
    data[at++] = n[2];
    data[at++] = col[0];
    data[at++] = col[1];
    data[at++] = col[2];
  }
  return at;
};

/**
 * Assemble part defs into a mesh-pass `Mesh`: non-indexed flat-shaded tris,
 * 9 floats/vertex (pos, outward normal, part rgb), `hasColor` set.
 */
export const assembleShipMesh = (parts: readonly PartDef[]): Mesh => {
  const tris: Tri[] = [];
  const colors: V3[] = [];
  const centres: V3[] = [];
  for (const def of parts) {
    // Segmented parts bake plate-by-plate: each plate is its own convex prim
    // with its own centre, so the outward-normal fix stays exact.
    for (const plate of expandSeg(def)) {
      const before = tris.length;
      bakePart(plate, buildPrim(plate.prim), tris, colors);
      trackCentres(plate, tris.length - before, centres);
    }
  }
  const data = new Float32Array(tris.length * 3 * 9);
  let o = 0;
  for (let t = 0; t < tris.length; t++) {
    const n = outwardNormal(tris[t], centres[t]);
    if (n) o = writeTri(data, o, tris[t], n, colors[t]);
  }
  return {
    data: data.subarray(0, o) as Float32Array,
    vertexCount: o / 9,
    hasColor: true,
  };
};

/**
 * Plume cone for the additive engine pass: hex cross-section, nozzle ring at
 * y=0 (radius 1) tapering to a tip at y=-1. Unit-sized; the shader scales by
 * anchor width / plume length. Normals point outward (unused for lighting,
 * mesh-pass just requires the interleave).
 */
export const makePlumeMesh = (): Mesh => {
  const prim = hexPrism(0.15);
  // Reposition: hexPrism spans y in [-0.5, 0.5] with the taper at +y; the
  // plume wants its wide ring at y=0 and the tip trailing to y=-1.
  const verts = prim.verts.map((v): V3 => [v[0] * 2, -(v[1] + 0.5), v[2] * 2]);
  const tris: Tri[] = prim.faces.map(([a, b, c]) => [
    verts[a],
    verts[b],
    verts[c],
  ]);
  const data = new Float32Array(tris.length * 3 * 6);
  let o = 0;
  for (const tri of tris) {
    const n = outwardNormal(tri, [0, -0.5, 0]);
    if (!n) continue;
    for (const p of tri) {
      data[o++] = p[0];
      data[o++] = p[1];
      data[o++] = p[2];
      data[o++] = n[0];
      data[o++] = n[1];
      data[o++] = n[2];
    }
  }
  return { data: data.subarray(0, o) as Float32Array, vertexCount: o / 6 };
};

// --- picking --------------------------------------------------------------------

/** Möller–Trumbore ray/triangle: returns t along `dir` or null on miss. */
const rayTri = (o: V3, d: V3, t0: V3, t1: V3, t2: V3): number | null => {
  const e1 = sub(t1, t0);
  const e2 = sub(t2, t0);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  const s = sub(o, t0);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  return v < 0 || u + v > 1 ? null : dot(e2, q) * inv;
};

/** Bake one part's triangles (mirror + seg plates included) in ship-local
 * space — picking any plate of a chain selects the owning PartDef. */
const bakePartTris = (def: PartDef): Tri[] => {
  const tris: Tri[] = [];
  for (const plate of expandSeg(def)) {
    bakePart(plate, buildPrim(plate.prim), tris, []);
  }
  return tris;
};

/**
 * Pick the part hit by a ship-local ray (`dir` toward the viewer): the
 * intersection closest to the viewer wins. Editor click-to-select — clicking
 * a mirrored copy selects the same PartDef. Returns the part index or null.
 */
export const pickPart = (
  parts: readonly PartDef[],
  origin: V3,
  dir: V3,
): number | null => {
  let bestT = Number.NEGATIVE_INFINITY;
  let hit: number | null = null;
  parts.forEach((def, i) => {
    for (const [a, b, c] of bakePartTris(def)) {
      const t = rayTri(origin, dir, a, b, c);
      if (t !== null && t > bestT) {
        bestT = t;
        hit = i;
      }
    }
  });
  return hit;
};

/** Build the baked hull mesh for a ship class from the stock recipe. */
export const makeShipMesh = (cls: ShipClass): Mesh =>
  assembleShipMesh(RECIPES[cls]);
