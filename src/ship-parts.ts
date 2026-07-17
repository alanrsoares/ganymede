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

// --- declarative prim + part defs ----------------------------------------------

/** Serializable primitive description — what the hull designer edits. */
export type PrimDef =
  | { kind: "slab"; tx: number; tz: number; bevel?: number }
  | { kind: "hex"; taper: number }
  | { kind: "orb" };

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
const SLAB = (tx: number, tz: number, bevel?: number): PrimDef =>
  bevel ? { kind: "slab", tx, tz, bevel } : { kind: "slab", tx, tz };
const HEX = (taper: number): PrimDef => ({ kind: "hex", taper });
const ORB: PrimDef = { kind: "orb" };

// Hull design language (see .agents/skills/hull-design): masses overlap
// deeply along the spine so silhouettes stay continuous — nothing floats.
// Wings root INSIDE the fuselage and sweep back; engines embed in the tail
// mass with only the acid lip protruding. Big → medium → small rhythm:
// one dominant mass, secondary pods/wings, then greebles.

/** scout — "Lamprey": jawless eel-dart, ventral sucker maw, dorsal eye. */
const SCOUT: PartDef[] = [
  // Core fuselage, strong taper to the nose.
  {
    prim: SLAB(0.22, 0.45, 0.1),
    scale: [0.34, 1.7, 0.26],
    pos: [0, 0.15, 0],
    color: "bone",
  },
  // Aft body — wider, overlapping the core by most of its length.
  {
    prim: SLAB(0.6, 0.7, 0.12),
    scale: [0.44, 0.9, 0.3],
    pos: [0, -0.55, 0.02],
    color: "carapace",
  },
  // Dorsal ridge blending the two masses.
  {
    prim: SLAB(0.15, 0.3, 0.06),
    scale: [0.12, 1.3, 0.14],
    pos: [0, -0.15, 0.16],
    color: "bone",
  },
  // Ventral sucker maw under the nose, ringed by feeder fangs.
  {
    prim: SLAB(0.5, 0.4, 0.06),
    scale: [0.18, 0.42, 0.12],
    pos: [0, 0.72, -0.08],
    color: "maw",
  },
  {
    prim: SLAB(0.05, 0.05),
    scale: [0.05, 0.22, 0.05],
    rot: [deg(-78), 0, 0],
    pos: [0.08, 0.88, -0.1],
    color: "fang",
    mirror: true,
  },
  // Eye sunk into the ridge, port side. Not mirrored.
  {
    prim: ORB,
    scale: [0.2, 0.2, 0.2],
    pos: [-0.09, 0.45, 0.12],
    color: "eye",
  },
  // Forward canards, rooted in the core, swept back.
  {
    prim: SLAB(0.1, 0.35, 0.06),
    scale: [0.42, 0.5, 0.05],
    rot: [0, deg(8), -deg(38)],
    pos: [0.28, 0.05, 0],
    color: "carapace",
    mirror: true,
  },
  // Main wings off the aft body, steeper sweep, barbed tips.
  {
    prim: SLAB(0.12, 0.4, 0.08),
    scale: [0.55, 0.6, 0.06],
    rot: [0, 0, -deg(42)],
    pos: [0.26, -0.55, 0.04],
    color: "bone",
    mirror: true,
  },
  {
    prim: SLAB(0.04, 0.04),
    scale: [0.04, 0.26, 0.04],
    rot: [0, 0, -deg(52)],
    pos: [0.46, -0.75, 0.04],
    color: "fang",
    mirror: true,
  },
  // Spine barb — asymmetric, leaning starboard.
  {
    prim: SLAB(0.05, 0.05),
    scale: [0.05, 0.3, 0.05],
    rot: [deg(-30), 0, deg(15)],
    pos: [0.07, -0.35, 0.22],
    color: "fang",
  },
  // Single engine polyp buried in the aft body, acid lip out.
  {
    prim: HEX(0.7),
    scale: [0.18, 0.5, 0.18],
    pos: [0, -0.95, 0],
    color: "sinew",
  },
  {
    prim: HEX(0.9),
    scale: [0.12, 0.14, 0.12],
    pos: [0, -1.16, 0],
    color: "acid",
  },
];

/** fighter — "Ossuary": rib-caged cross gunboat, tusk barrels, bone wings. */
const FIGHTER: PartDef[] = [
  // Fuselage core.
  {
    prim: SLAB(0.4, 0.55, 0.12),
    scale: [0.42, 1.5, 0.3],
    pos: [0, 0.1, 0],
    color: "carapace",
  },
  // Nose wedge continuing the taper.
  {
    prim: SLAB(0.25, 0.35, 0.08),
    scale: [0.3, 0.5, 0.22],
    pos: [0, 0.82, -0.01],
    color: "bone",
  },
  // Aft block, wider than the core — engine housing.
  {
    prim: SLAB(0.7, 0.75, 0.12),
    scale: [0.55, 0.62, 0.32],
    pos: [0, -0.62, 0],
    color: "carapace",
  },
  // Bone-blade wings, rooted mid-fuselage, swept back — the cross span.
  {
    prim: SLAB(0.18, 0.5, 0.08),
    scale: [0.75, 0.7, 0.07],
    rot: [0, deg(6), -deg(24)],
    pos: [0.45, -0.15, 0.02],
    color: "bone",
    mirror: true,
  },
  // Carapace leading-edge plates layered on the wing roots.
  {
    prim: SLAB(0.1, 0.4, 0.06),
    scale: [0.4, 0.3, 0.05],
    rot: [0, 0, -deg(24)],
    pos: [0.36, -0.08, 0.06],
    color: "carapace",
    mirror: true,
  },
  {
    prim: SLAB(0.05, 0.05),
    scale: [0.05, 0.3, 0.05],
    rot: [0, 0, -deg(30)],
    pos: [0.76, -0.36, 0.02],
    color: "fang",
    mirror: true,
  },
  // Rib plates wrapping the spine, shrinking aft.
  {
    prim: SLAB(0.75, 0.5, 0.06),
    scale: [0.5, 0.14, 0.12],
    pos: [0, 0.3, 0.16],
    color: "bone",
  },
  {
    prim: SLAB(0.75, 0.5, 0.06),
    scale: [0.44, 0.13, 0.11],
    pos: [0, 0.02, 0.19],
    color: "bone",
  },
  {
    prim: SLAB(0.75, 0.5, 0.06),
    scale: [0.38, 0.12, 0.1],
    pos: [0, -0.26, 0.2],
    color: "bone",
  },
  // Twin tusk barrels rooted in sinew polyps.
  {
    prim: SLAB(0.08, 0.08),
    scale: [0.07, 0.7, 0.07],
    rot: [0, 0, deg(2)],
    pos: [0.22, 0.75, -0.04],
    color: "fang",
    mirror: true,
  },
  {
    prim: HEX(0.8),
    scale: [0.1, 0.25, 0.1],
    pos: [0.22, 0.4, -0.04],
    color: "sinew",
    mirror: true,
  },
  // Eye on the nose ridge, starboard. Not mirrored.
  {
    prim: ORB,
    scale: [0.17, 0.17, 0.17],
    pos: [0.1, 0.6, 0.14],
    color: "eye",
  },
  // Antenna barb — asymmetric, port aft.
  {
    prim: SLAB(0.04, 0.04),
    scale: [0.04, 0.32, 0.04],
    rot: [deg(-35), 0, -deg(10)],
    pos: [-0.12, -0.5, 0.24],
    color: "fang",
  },
  // Twin engines buried in the aft block.
  {
    prim: HEX(0.75),
    scale: [0.15, 0.45, 0.15],
    pos: [0.2, -0.95, 0],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.1, 0.13, 0.1],
    pos: [0.2, -1.18, 0],
    color: "acid",
    mirror: true,
  },
];

/** heavy — "Leviathan": whale barge, layered shell over bone belly, gaping maw. */
const HEAVY: PartDef[] = [
  // Main carapace back — the dominant mass.
  {
    prim: SLAB(0.6, 0.65, 0.16),
    scale: [1.0, 1.6, 0.42],
    pos: [0, -0.1, 0.06],
    color: "carapace",
  },
  // Bone belly layered beneath.
  {
    prim: SLAB(0.7, 0.6, 0.12),
    scale: [0.8, 1.3, 0.3],
    pos: [0, 0, -0.14],
    color: "bone",
  },
  // Brow hood pushing forward into the head.
  {
    prim: SLAB(0.5, 0.5, 0.12),
    scale: [0.6, 0.55, 0.3],
    pos: [0, 0.62, 0.02],
    color: "carapace",
  },
  // Gaping maw inset under the brow, ringed by teeth.
  {
    prim: SLAB(0.55, 0.4, 0.08),
    scale: [0.42, 0.35, 0.24],
    pos: [0, 0.85, -0.06],
    color: "maw",
  },
  {
    prim: SLAB(0.04, 0.04),
    scale: [0.07, 0.26, 0.07],
    rot: [deg(-90), 0, 0],
    pos: [0.16, 1.0, -0.02],
    color: "fang",
    mirror: true,
  },
  {
    prim: SLAB(0.04, 0.04),
    scale: [0.06, 0.22, 0.06],
    rot: [deg(-90), 0, 0],
    pos: [0.05, 1.02, -0.12],
    color: "fang",
    mirror: true,
  },
  // Dorsal shell plates, shrinking aft, second one leaning port.
  {
    prim: SLAB(0.85, 0.6, 0.1),
    scale: [0.55, 0.7, 0.12],
    pos: [0, 0.05, 0.34],
    color: "bone",
  },
  {
    prim: SLAB(0.8, 0.6, 0.1),
    scale: [0.4, 0.45, 0.1],
    pos: [-0.05, -0.55, 0.36],
    color: "bone",
  },
  // Cyclopean eye on the brow, starboard. Not mirrored. It watches.
  {
    prim: ORB,
    scale: [0.22, 0.22, 0.22],
    pos: [0.3, 0.42, 0.28],
    color: "eye",
  },
  // Flank engine pods embedded in the hull sides.
  {
    prim: HEX(0.8),
    scale: [0.26, 1.0, 0.26],
    pos: [0.55, -0.15, -0.02],
    color: "carapace",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.13, 0.14, 0.13],
    pos: [0.55, -0.72, -0.02],
    color: "acid",
    mirror: true,
  },
  // Centre engine pair buried in the tail.
  {
    prim: HEX(0.75),
    scale: [0.16, 0.5, 0.16],
    pos: [0.18, -1.0, -0.04],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.11, 0.13, 0.11],
    pos: [0.18, -1.24, -0.04],
    color: "acid",
    mirror: true,
  },
  // Mine barnacle cluster, dorsal port. Asymmetric.
  {
    prim: HEX(0.5),
    scale: [0.14, 0.2, 0.14],
    pos: [-0.3, -0.35, 0.3],
    color: "acid",
  },
  {
    prim: HEX(0.5),
    scale: [0.1, 0.14, 0.1],
    pos: [-0.42, -0.2, 0.28],
    color: "acid",
  },
];

/** interceptor — "Stinger": wasp needle, thorax + abdomen, egg-sac clutch. */
const INTERCEPTOR: PartDef[] = [
  // Needle spine, nose to tail.
  {
    prim: SLAB(0.12, 0.25, 0.08),
    scale: [0.2, 2.2, 0.18],
    pos: [0, 0, 0],
    color: "bone",
  },
  // Stinger fang continuing the nose.
  {
    prim: SLAB(0.03, 0.03),
    scale: [0.07, 0.5, 0.07],
    pos: [0, 0.9, 0],
    color: "fang",
  },
  // Thorax bulge around the spine.
  {
    prim: SLAB(0.45, 0.6, 0.1),
    scale: [0.24, 0.7, 0.22],
    pos: [0, 0.25, 0.02],
    color: "carapace",
  },
  // Sinew waist joining thorax to abdomen.
  {
    prim: HEX(0.85),
    scale: [0.16, 0.35, 0.16],
    pos: [0, -0.28, 0],
    color: "sinew",
  },
  // Abdomen bulb aft.
  {
    prim: SLAB(0.55, 0.5, 0.14),
    scale: [0.3, 0.75, 0.26],
    pos: [0, -0.68, 0],
    color: "carapace",
  },
  // Forward canards off the thorax.
  {
    prim: SLAB(0.08, 0.35, 0.05),
    scale: [0.3, 0.4, 0.04],
    rot: [0, 0, -deg(30)],
    pos: [0.18, 0.35, 0.02],
    color: "carapace",
    mirror: true,
  },
  // Main fins off the abdomen, steep sweep.
  {
    prim: SLAB(0.1, 0.4, 0.06),
    scale: [0.5, 0.55, 0.05],
    rot: [0, 0, -deg(50)],
    pos: [0.28, -0.75, 0.03],
    color: "bone",
    mirror: true,
  },
  // Vertical tail fin.
  {
    prim: SLAB(0.12, 0.35, 0.05),
    scale: [0.05, 0.45, 0.32],
    pos: [0, -0.85, 0.2],
    color: "carapace",
  },
  // Egg sacs clutched on the abdomen — one extra, off-pair. It's about to hatch.
  {
    prim: ORB,
    scale: [0.09, 0.12, 0.09],
    pos: [0.2, -0.55, 0.1],
    color: "acid",
    mirror: true,
  },
  {
    prim: ORB,
    scale: [0.08, 0.1, 0.08],
    pos: [0.14, -0.78, 0.16],
    color: "acid",
  },
  // Eye at the thorax front, port. Not mirrored.
  {
    prim: ORB,
    scale: [0.13, 0.13, 0.13],
    pos: [-0.06, 0.55, 0.09],
    color: "eye",
  },
  // Twin engines buried in the abdomen.
  {
    prim: HEX(0.7),
    scale: [0.11, 0.45, 0.11],
    pos: [0.13, -0.98, -0.02],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.08, 0.11, 0.08],
    pos: [0.13, -1.2, -0.02],
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
  scout: [{ pos: [0, -1.22, 0], w: 0.17 }],
  fighter: [
    { pos: [0.2, -1.24, 0], w: 0.14 },
    { pos: [-0.2, -1.24, 0], w: 0.14 },
  ],
  heavy: [
    { pos: [0.55, -0.78, -0.02], w: 0.16 },
    { pos: [-0.55, -0.78, -0.02], w: 0.16 },
    { pos: [0.18, -1.3, -0.04], w: 0.14 },
    { pos: [-0.18, -1.3, -0.04], w: 0.14 },
  ],
  interceptor: [
    { pos: [0.13, -1.25, -0.02], w: 0.12 },
    { pos: [-0.13, -1.25, -0.02], w: 0.12 },
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
