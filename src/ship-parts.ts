// Procedural ship hulls assembled from a small kit of faceted convex parts,
// in the cosmic-horror-meets-acid-cartoon direction: bone carapace masses,
// fang spikes, glowing polyps and a cyclopean eye orb per hull. Built once on
// CPU (like mesh.ts) and instanced by the ship mesh pass. Vertex colours are
// baked per part; values > 1 mark emissive surfaces the shader lets bloom.
//
// Recipes are plain data (`PartDef`): declarative prim params + palette keys,
// so the drydock hull designer can edit, serialize and re-bake them live.
//
// Conventions: ship local space has the nose along +Y, +Z toward the viewer,
// authored roughly within ±1.1 along Y so instance `radius` ≈ half-length px.

import type { Mesh } from "./mesh";

export type V3 = [number, number, number];
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

// --- declarative prim + part defs ----------------------------------------------

/** Serializable primitive description — what the hull designer edits. */
export type PrimDef =
  | { kind: "slab"; tx: number; tz: number }
  | { kind: "hex"; taper: number }
  | { kind: "orb" };

export const buildPrim = (def: PrimDef): Prim => {
  switch (def.kind) {
    case "slab":
      return slab(def.tx, def.tz);
    case "hex":
      return hexPrism(def.taper);
    case "orb":
      return orb();
  }
};

// --- palette ------------------------------------------------------------------
// Bone carapace over void-purple sinew, acid-green emissives (values > 1 mark
// emissive surfaces), iridescent magenta eye. Team tint multiplies on top in
// the shader (same k=0.55 near-white multiply as sprite hulls used).

export const PALETTE = {
  bone: [0.78, 0.74, 0.64],
  carapace: [0.45, 0.38, 0.55], // void purple
  sinew: [0.28, 0.2, 0.34],
  fang: [0.88, 0.85, 0.72],
  acid: [1.4, 2.4, 0.5], // emissive portal green
  eye: [2.2, 0.5, 2.0], // emissive magenta iris
  maw: [0.1, 0.06, 0.12],
} as const satisfies Record<string, V3>;
export type PaletteKey = keyof typeof PALETTE;
export const PALETTE_KEYS = Object.keys(PALETTE) as readonly PaletteKey[];

/** One hull part: prim + placement + palette colour. Plain serializable data. */
export interface PartDef {
  prim: PrimDef;
  /** Per-axis scale applied before rotation. */
  scale: V3;
  /** Euler rotation in radians, applied Rz·Ry·Rx. */
  rot?: V3;
  pos: V3;
  color: PaletteKey;
  /** Also bake an x-mirrored copy. */
  mirror?: boolean;
}

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
    const before = tris.length;
    bakePart(def, buildPrim(def.prim), tris, colors);
    trackCentres(def, tris.length - before, centres);
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

// --- recipes -------------------------------------------------------------------
// Aspect ratio carries the tiny-scale read (dart / cross / slab / needle);
// the gear sells the role up close. A couple of parts per hull are
// deliberately NOT mirrored — eldritch things are never quite symmetric.

const deg = (d: number): number => (d * Math.PI) / 180;
const SLAB = (tx: number, tz: number): PrimDef => ({ kind: "slab", tx, tz });
const HEX = (taper: number): PrimDef => ({ kind: "hex", taper });
const ORB: PrimDef = { kind: "orb" };

/** scout — "Lamprey": slim recon dart, cyclopean eye, barbed spine. */
const SCOUT: PartDef[] = [
  {
    prim: SLAB(0.28, 0.4),
    scale: [0.38, 1.9, 0.24],
    pos: [0, 0.05, 0],
    color: "bone",
  },
  { prim: ORB, scale: [0.22, 0.22, 0.22], pos: [0, 0.62, 0.1], color: "eye" },
  {
    prim: SLAB(0.2, 0.5),
    scale: [0.5, 0.6, 0.06],
    rot: [0, 0, -deg(34)],
    pos: [0.34, -0.3, 0],
    color: "carapace",
    mirror: true,
  },
  // Dorsal barb row — asymmetric, leaning starboard.
  {
    prim: SLAB(0.05, 0.05),
    scale: [0.06, 0.34, 0.06],
    rot: [deg(-28), 0, deg(12)],
    pos: [0.05, -0.15, 0.18],
    color: "fang",
  },
  {
    prim: SLAB(0.05, 0.05),
    scale: [0.05, 0.26, 0.05],
    rot: [deg(-24), 0, deg(18)],
    pos: [0.09, -0.48, 0.16],
    color: "fang",
  },
  {
    prim: HEX(0.7),
    scale: [0.16, 0.5, 0.16],
    pos: [0, -0.92, 0],
    color: "sinew",
  },
  {
    prim: HEX(0.9),
    scale: [0.1, 0.16, 0.1],
    pos: [0, -1.2, 0],
    color: "acid",
  },
];

/** fighter — "Ossuary": cross-span gunboat, twin fang barrels, rib plates. */
const FIGHTER: PartDef[] = [
  {
    prim: SLAB(0.45, 0.5),
    scale: [0.5, 1.5, 0.3],
    pos: [0, 0, 0],
    color: "carapace",
  },
  { prim: ORB, scale: [0.18, 0.18, 0.18], pos: [0, 0.42, 0.16], color: "eye" },
  // Bone-blade wings: span wider than the hull is long.
  {
    prim: SLAB(0.12, 0.4),
    scale: [0.7, 0.55, 0.07],
    rot: [0, 0, -deg(9)],
    pos: [0.62, -0.05, 0],
    color: "bone",
    mirror: true,
  },
  // Rib plates across the spine.
  {
    prim: SLAB(0.7, 0.5),
    scale: [0.56, 0.16, 0.1],
    pos: [0, 0.1, 0.18],
    color: "bone",
  },
  {
    prim: SLAB(0.7, 0.5),
    scale: [0.5, 0.14, 0.1],
    pos: [0, -0.22, 0.2],
    color: "bone",
  },
  // Twin fang barrels — canted slightly like tusks.
  {
    prim: SLAB(0.06, 0.06),
    scale: [0.08, 0.8, 0.08],
    rot: [0, 0, deg(3)],
    pos: [0.28, 0.62, -0.02],
    color: "fang",
    mirror: true,
  },
  {
    prim: HEX(0.75),
    scale: [0.14, 0.45, 0.14],
    pos: [0.2, -0.84, 0],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.09, 0.14, 0.09],
    pos: [0.2, -1.1, 0],
    color: "acid",
    mirror: true,
  },
];

/** heavy — "Leviathan": bloated carapace slab, gaping ram maw, mine barnacles. */
const HEAVY: PartDef[] = [
  {
    prim: SLAB(0.75, 0.7),
    scale: [0.95, 1.45, 0.44],
    pos: [0, -0.05, 0],
    color: "carapace",
  },
  // Ram maw: blunt dark mouth ringed by fang wedges.
  {
    prim: SLAB(0.55, 0.55),
    scale: [0.66, 0.45, 0.46],
    pos: [0, 0.72, 0],
    color: "maw",
  },
  {
    prim: SLAB(0.04, 0.04),
    scale: [0.09, 0.3, 0.09],
    rot: [deg(-90), 0, 0],
    pos: [0.22, 0.95, 0.12],
    color: "fang",
    mirror: true,
  },
  {
    prim: SLAB(0.04, 0.04),
    scale: [0.09, 0.3, 0.09],
    rot: [deg(-90), 0, 0],
    pos: [0.08, 0.98, -0.14],
    color: "fang",
    mirror: true,
  },
  // Dorsal carapace shells.
  {
    prim: SLAB(0.8, 0.6),
    scale: [0.68, 0.85, 0.14],
    pos: [0, 0.02, 0.28],
    color: "bone",
  },
  {
    prim: SLAB(0.7, 0.6),
    scale: [0.42, 0.5, 0.12],
    pos: [-0.06, -0.42, 0.36],
    color: "bone",
  },
  // Cyclopean eye off-centre on the carapace. Not mirrored. It watches.
  {
    prim: ORB,
    scale: [0.24, 0.24, 0.24],
    pos: [0.28, 0.18, 0.32],
    color: "eye",
  },
  // Mine barnacle clusters, underslung.
  {
    prim: HEX(0.5),
    scale: [0.16, 0.24, 0.16],
    rot: [deg(180), 0, 0],
    pos: [0.55, -0.5, -0.26],
    color: "acid",
    mirror: true,
  },
  {
    prim: HEX(0.75),
    scale: [0.15, 0.4, 0.15],
    pos: [0.55, -0.92, 0],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.75),
    scale: [0.15, 0.4, 0.15],
    pos: [0.19, -0.92, 0],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.1, 0.12, 0.1],
    pos: [0.55, -1.14, 0],
    color: "acid",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.1, 0.12, 0.1],
    pos: [0.19, -1.14, 0],
    color: "acid",
    mirror: true,
  },
  // Flank pods (carrier bulk).
  {
    prim: HEX(0.85),
    scale: [0.18, 0.8, 0.18],
    pos: [0.72, -0.1, 0.04],
    color: "carapace",
    mirror: true,
  },
];

/** interceptor — "Stinger": bone-needle spine, egg-sac missile polyps. */
const INTERCEPTOR: PartDef[] = [
  {
    prim: SLAB(0.2, 0.3),
    scale: [0.26, 2.2, 0.22],
    pos: [0, 0, 0],
    color: "bone",
  },
  { prim: ORB, scale: [0.14, 0.14, 0.14], pos: [0, 0.52, 0.1], color: "eye" },
  // Back-swept spine fins.
  {
    prim: SLAB(0.08, 0.4),
    scale: [0.44, 0.42, 0.05],
    rot: [0, 0, -deg(46)],
    pos: [0.22, -0.76, 0],
    color: "carapace",
    mirror: true,
  },
  {
    prim: SLAB(0.15, 0.3),
    scale: [0.05, 0.34, 0.28],
    pos: [0, -0.82, 0.14],
    color: "carapace",
  },
  // Missile polyp sacs with emissive tips — clutch of eggs about to hatch.
  {
    prim: HEX(0.6),
    scale: [0.15, 0.5, 0.15],
    pos: [0.28, 0.08, -0.02],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.15),
    scale: [0.07, 0.24, 0.07],
    pos: [0.28, 0.42, -0.02],
    color: "acid",
    mirror: true,
  },
  {
    prim: HEX(0.15),
    scale: [0.05, 0.16, 0.05],
    rot: [0, 0, deg(14)],
    pos: [0.36, 0.3, 0.06],
    color: "acid",
  },
  {
    prim: HEX(0.7),
    scale: [0.12, 0.5, 0.12],
    pos: [0.11, -1.04, 0],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.08, 0.12, 0.08],
    pos: [0.11, -1.32, 0],
    color: "acid",
    mirror: true,
  },
];

export const RECIPES = {
  scout: SCOUT,
  fighter: FIGHTER,
  heavy: HEAVY,
  interceptor: INTERCEPTOR,
} as const;

/** One engine anchor: nozzle exit in ship-local units + plume width. */
export interface EngineAnchor {
  pos: V3;
  w: number;
}

// Nozzle exits per class, matching each recipe's acid nozzle parts (mirrored
// pairs listed explicitly so the plume pass needs no mirror logic).
export const ENGINES: Record<keyof typeof RECIPES, readonly EngineAnchor[]> = {
  scout: [{ pos: [0, -1.2, 0], w: 0.16 }],
  fighter: [
    { pos: [0.2, -1.1, 0], w: 0.14 },
    { pos: [-0.2, -1.1, 0], w: 0.14 },
  ],
  heavy: [
    { pos: [0.55, -1.14, 0], w: 0.15 },
    { pos: [-0.55, -1.14, 0], w: 0.15 },
    { pos: [0.19, -1.14, 0], w: 0.15 },
    { pos: [-0.19, -1.14, 0], w: 0.15 },
  ],
  interceptor: [
    { pos: [0.11, -1.32, 0], w: 0.12 },
    { pos: [-0.11, -1.32, 0], w: 0.12 },
  ],
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
  if (v < 0 || u + v > 1) return null;
  return dot(e2, q) * inv;
};

/** Bake one part's triangles (mirror copies included) in ship-local space. */
const bakePartTris = (def: PartDef): Tri[] => {
  const tris: Tri[] = [];
  bakePart(def, buildPrim(def.prim), tris, []);
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

export type ShipClass = keyof typeof RECIPES;
export const SHIP_CLASSES = Object.keys(RECIPES) as readonly ShipClass[];

/** Build the baked hull mesh for a ship class from the stock recipe. */
export const makeShipMesh = (cls: ShipClass): Mesh =>
  assembleShipMesh(RECIPES[cls]);
