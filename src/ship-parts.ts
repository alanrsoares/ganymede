// Procedural ship hulls assembled from a small kit of faceted convex parts,
// in the cosmic-horror-meets-acid-cartoon direction: bone carapace masses,
// fang spikes, glowing polyps and a cyclopean eye orb per hull. Built once on
// CPU (like mesh.ts) and instanced by the ship mesh pass. Vertex colours are
// baked per part; values > 1 mark emissive surfaces the shader lets bloom.
//
// Conventions: ship local space has the nose along +Y, +Z toward the viewer,
// authored roughly within ±1.1 along Y so instance `radius` ≈ half-length px.

import type { Mesh } from "./mesh";

type V3 = [number, number, number];
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

// --- assembler ----------------------------------------------------------------

interface PartSpec {
  prim: Prim;
  /** Per-axis scale applied before rotation. */
  scale: V3;
  /** Euler rotation, applied Rz·Ry·Rx. */
  rot?: V3;
  pos: V3;
  /** Base colour; components > 1 render emissive (see ship.wgsl). */
  color: V3;
  /** Also bake an x-mirrored copy. */
  mirror?: boolean;
}

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
const bakePart = (spec: PartSpec, out: Tri[], colors: V3[]): void => {
  const m = rotMat(spec.rot ?? [0, 0, 0]);
  for (const mx of spec.mirror ? [1, -1] : [1]) {
    const centre: V3 = [spec.pos[0] * mx, spec.pos[1], spec.pos[2]];
    const verts = spec.prim.verts.map((v): V3 => {
      const s = mulV(m, [
        v[0] * spec.scale[0],
        v[1] * spec.scale[1],
        v[2] * spec.scale[2],
      ]);
      return [s[0] * mx + centre[0], s[1] + centre[1], s[2] + centre[2]];
    });
    for (const [a, b, c] of spec.prim.faces) {
      out.push([verts[a], verts[b], verts[c]]);
      colors.push(spec.color);
    }
  }
};

/** Record each baked tri's part centre (mirror-aware) for the outward fix. */
const trackCentres = (spec: PartSpec, added: number, centres: V3[]): void => {
  const half = spec.mirror ? added / 2 : added;
  for (let i = 0; i < added; i++) {
    const mx = spec.mirror && i >= half ? -1 : 1;
    centres.push([spec.pos[0] * mx, spec.pos[1], spec.pos[2]]);
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
 * Assemble part specs into a mesh-pass `Mesh`: non-indexed flat-shaded tris,
 * 9 floats/vertex (pos, outward normal, part rgb), `hasColor` set.
 */
export const assembleShipMesh = (parts: readonly PartSpec[]): Mesh => {
  const tris: Tri[] = [];
  const colors: V3[] = [];
  const centres: V3[] = [];
  for (const spec of parts) {
    const before = tris.length;
    bakePart(spec, tris, colors);
    trackCentres(spec, tris.length - before, centres);
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

// --- palette ------------------------------------------------------------------
// Bone carapace over void-purple sinew, acid-green emissives (values > 1 mark
// emissive surfaces), iridescent magenta eye. Team tint multiplies on top in
// the shader (same k=0.55 near-white multiply as sprite hulls used).

const BONE: V3 = [0.78, 0.74, 0.64];
const CARAPACE: V3 = [0.45, 0.38, 0.55]; // void purple
const SINEW: V3 = [0.28, 0.2, 0.34];
const FANG: V3 = [0.88, 0.85, 0.72];
const ACID: V3 = [1.4, 2.4, 0.5]; // emissive portal green
const EYE: V3 = [2.2, 0.5, 2.0]; // emissive magenta iris
const MAW: V3 = [0.1, 0.06, 0.12];

// --- recipes -------------------------------------------------------------------
// Aspect ratio carries the tiny-scale read (dart / cross / slab / needle);
// the gear sells the role up close. A couple of parts per hull are
// deliberately NOT mirrored — eldritch things are never quite symmetric.

const deg = (d: number): number => (d * Math.PI) / 180;

/** scout — "Lamprey": slim recon dart, cyclopean eye, barbed spine. */
const SCOUT: PartSpec[] = [
  {
    prim: slab(0.28, 0.4),
    scale: [0.38, 1.9, 0.24],
    pos: [0, 0.05, 0],
    color: BONE,
  },
  { prim: orb(), scale: [0.22, 0.22, 0.22], pos: [0, 0.62, 0.1], color: EYE },
  {
    prim: slab(0.2, 0.5),
    scale: [0.5, 0.6, 0.06],
    rot: [0, 0, -deg(34)],
    pos: [0.34, -0.3, 0],
    color: CARAPACE,
    mirror: true,
  },
  // Dorsal barb row — asymmetric, leaning starboard.
  {
    prim: slab(0.05, 0.05),
    scale: [0.06, 0.34, 0.06],
    rot: [deg(-28), 0, deg(12)],
    pos: [0.05, -0.15, 0.18],
    color: FANG,
  },
  {
    prim: slab(0.05, 0.05),
    scale: [0.05, 0.26, 0.05],
    rot: [deg(-24), 0, deg(18)],
    pos: [0.09, -0.48, 0.16],
    color: FANG,
  },
  {
    prim: hexPrism(0.7),
    scale: [0.16, 0.5, 0.16],
    pos: [0, -0.92, 0],
    color: SINEW,
  },
  {
    prim: hexPrism(0.9),
    scale: [0.1, 0.16, 0.1],
    pos: [0, -1.2, 0],
    color: ACID,
  },
];

/** fighter — "Ossuary": cross-span gunboat, twin fang barrels, rib plates. */
const FIGHTER: PartSpec[] = [
  {
    prim: slab(0.45, 0.5),
    scale: [0.5, 1.5, 0.3],
    pos: [0, 0, 0],
    color: CARAPACE,
  },
  { prim: orb(), scale: [0.18, 0.18, 0.18], pos: [0, 0.42, 0.16], color: EYE },
  // Bone-blade wings: span wider than the hull is long.
  {
    prim: slab(0.12, 0.4),
    scale: [0.7, 0.55, 0.07],
    rot: [0, 0, -deg(9)],
    pos: [0.62, -0.05, 0],
    color: BONE,
    mirror: true,
  },
  // Rib plates across the spine.
  {
    prim: slab(0.7, 0.5),
    scale: [0.56, 0.16, 0.1],
    pos: [0, 0.1, 0.18],
    color: BONE,
  },
  {
    prim: slab(0.7, 0.5),
    scale: [0.5, 0.14, 0.1],
    pos: [0, -0.22, 0.2],
    color: BONE,
  },
  // Twin fang barrels — canted slightly like tusks.
  {
    prim: slab(0.06, 0.06),
    scale: [0.08, 0.8, 0.08],
    rot: [0, 0, deg(3)],
    pos: [0.28, 0.62, -0.02],
    color: FANG,
    mirror: true,
  },
  {
    prim: hexPrism(0.75),
    scale: [0.14, 0.45, 0.14],
    pos: [0.2, -0.84, 0],
    color: SINEW,
    mirror: true,
  },
  {
    prim: hexPrism(0.9),
    scale: [0.09, 0.14, 0.09],
    pos: [0.2, -1.1, 0],
    color: ACID,
    mirror: true,
  },
];

/** heavy — "Leviathan": bloated carapace slab, gaping ram maw, mine barnacles. */
const HEAVY: PartSpec[] = [
  {
    prim: slab(0.75, 0.7),
    scale: [0.95, 1.45, 0.44],
    pos: [0, -0.05, 0],
    color: CARAPACE,
  },
  // Ram maw: blunt dark mouth ringed by fang wedges.
  {
    prim: slab(0.55, 0.55),
    scale: [0.66, 0.45, 0.46],
    pos: [0, 0.72, 0],
    color: MAW,
  },
  {
    prim: slab(0.04, 0.04),
    scale: [0.09, 0.3, 0.09],
    rot: [deg(-90), 0, 0],
    pos: [0.22, 0.95, 0.12],
    color: FANG,
    mirror: true,
  },
  {
    prim: slab(0.04, 0.04),
    scale: [0.09, 0.3, 0.09],
    rot: [deg(-90), 0, 0],
    pos: [0.08, 0.98, -0.14],
    color: FANG,
    mirror: true,
  },
  // Dorsal carapace shells.
  {
    prim: slab(0.8, 0.6),
    scale: [0.68, 0.85, 0.14],
    pos: [0, 0.02, 0.28],
    color: BONE,
  },
  {
    prim: slab(0.7, 0.6),
    scale: [0.42, 0.5, 0.12],
    pos: [-0.06, -0.42, 0.36],
    color: BONE,
  },
  // Cyclopean eye off-centre on the carapace. Not mirrored. It watches.
  {
    prim: orb(),
    scale: [0.24, 0.24, 0.24],
    pos: [0.28, 0.18, 0.32],
    color: EYE,
  },
  // Mine barnacle clusters, underslung.
  {
    prim: hexPrism(0.5),
    scale: [0.16, 0.24, 0.16],
    rot: [deg(180), 0, 0],
    pos: [0.55, -0.5, -0.26],
    color: ACID,
    mirror: true,
  },
  {
    prim: hexPrism(0.75),
    scale: [0.15, 0.4, 0.15],
    pos: [0.55, -0.92, 0],
    color: SINEW,
    mirror: true,
  },
  {
    prim: hexPrism(0.75),
    scale: [0.15, 0.4, 0.15],
    pos: [0.19, -0.92, 0],
    color: SINEW,
    mirror: true,
  },
  {
    prim: hexPrism(0.9),
    scale: [0.1, 0.12, 0.1],
    pos: [0.55, -1.14, 0],
    color: ACID,
    mirror: true,
  },
  {
    prim: hexPrism(0.9),
    scale: [0.1, 0.12, 0.1],
    pos: [0.19, -1.14, 0],
    color: ACID,
    mirror: true,
  },
  // Flank pods (carrier bulk).
  {
    prim: hexPrism(0.85),
    scale: [0.18, 0.8, 0.18],
    pos: [0.72, -0.1, 0.04],
    color: CARAPACE,
    mirror: true,
  },
];

/** interceptor — "Stinger": bone-needle spine, egg-sac missile polyps. */
const INTERCEPTOR: PartSpec[] = [
  {
    prim: slab(0.2, 0.3),
    scale: [0.26, 2.2, 0.22],
    pos: [0, 0, 0],
    color: BONE,
  },
  { prim: orb(), scale: [0.14, 0.14, 0.14], pos: [0, 0.52, 0.1], color: EYE },
  // Back-swept spine fins.
  {
    prim: slab(0.08, 0.4),
    scale: [0.44, 0.42, 0.05],
    rot: [0, 0, -deg(46)],
    pos: [0.22, -0.76, 0],
    color: CARAPACE,
    mirror: true,
  },
  {
    prim: slab(0.15, 0.3),
    scale: [0.05, 0.34, 0.28],
    pos: [0, -0.82, 0.14],
    color: CARAPACE,
  },
  // Missile polyp sacs with emissive tips — clutch of eggs about to hatch.
  {
    prim: hexPrism(0.6),
    scale: [0.15, 0.5, 0.15],
    pos: [0.28, 0.08, -0.02],
    color: SINEW,
    mirror: true,
  },
  {
    prim: hexPrism(0.15),
    scale: [0.07, 0.24, 0.07],
    pos: [0.28, 0.42, -0.02],
    color: ACID,
    mirror: true,
  },
  {
    prim: hexPrism(0.15),
    scale: [0.05, 0.16, 0.05],
    rot: [0, 0, deg(14)],
    pos: [0.36, 0.3, 0.06],
    color: ACID,
  },
  {
    prim: hexPrism(0.7),
    scale: [0.12, 0.5, 0.12],
    pos: [0.11, -1.04, 0],
    color: SINEW,
    mirror: true,
  },
  {
    prim: hexPrism(0.9),
    scale: [0.08, 0.12, 0.08],
    pos: [0.11, -1.32, 0],
    color: ACID,
    mirror: true,
  },
];

const RECIPES = {
  scout: SCOUT,
  fighter: FIGHTER,
  heavy: HEAVY,
  interceptor: INTERCEPTOR,
} as const;

/** One engine anchor: nozzle exit in ship-local units + plume width. */
export interface EngineAnchor {
  readonly pos: V3;
  readonly w: number;
}

// Nozzle exits per class, matching each recipe's ACID nozzle parts (mirrored
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

export type ShipClass = keyof typeof RECIPES;
export const SHIP_CLASSES = Object.keys(RECIPES) as readonly ShipClass[];

/** Build the baked hull mesh for a ship class. */
export const makeShipMesh = (cls: ShipClass): Mesh =>
  assembleShipMesh(RECIPES[cls]);
