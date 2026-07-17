// Procedural meshes, built once on the CPU and instanced on the GPU: the faceted
// asteroid, the smooth shield sphere, and the vertex-coloured base/pad orb. All
// are non-indexed triangle lists so faces can be flat-shaded independently.

export interface Mesh {
  /**
   * Interleaved per vertex: [px, py, pz, nx, ny, nz] — plus [r, g, b] when
   * `hasColor` is set (9 floats/vertex instead of 6).
   */
  readonly data: Float32Array;
  readonly vertexCount: number;
  /** True when each vertex carries a trailing rgb colour (see mesh-pass). */
  readonly hasColor?: boolean;
}

type V3 = [number, number, number];

const norm = ([x, y, z]: V3): V3 => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

// Base icosahedron (12 verts, 20 faces).
const buildIcosahedron = (): {
  verts: V3[];
  faces: [number, number, number][];
} => {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: V3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map(norm as (v: number[]) => V3);
  const faces: [number, number, number][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  return { verts, faces };
};

// Split every triangle into four, projecting new midpoints back onto the sphere.
function subdivide(
  verts: V3[],
  faces: [number, number, number][],
): { verts: V3[]; faces: [number, number, number][] } {
  const mid = new Map<number, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    const hit = mid.get(key);
    if (hit !== undefined) return hit;
    const va = verts[a];
    const vb = verts[b];
    const m = norm([
      (va[0] + vb[0]) / 2,
      (va[1] + vb[1]) / 2,
      (va[2] + vb[2]) / 2,
    ]);
    const idx = verts.length;
    verts.push(m);
    mid.set(key, idx);
    return idx;
  };
  const out: [number, number, number][] = [];
  for (const [a, b, c] of faces) {
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    out.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  return { verts, faces: out };
}

// Deterministic lumpiness from a unit direction — a few out-of-phase sinusoids.
const displace = ([x, y, z]: V3): number =>
  1 +
  0.2 * Math.sin(x * 3.1 + y * 2.3) +
  0.13 * Math.sin(y * 4.2 - z * 1.7) +
  0.1 * Math.cos(z * 5.1 + x * 2.9) +
  0.06 * Math.sin(x * 7.3 + z * 6.1);

/** Build the faceted asteroid mesh (subdiv 2 → 320 faces → 960 verts). */
export function makeAsteroidMesh(subdiv = 2): Mesh {
  let { verts, faces } = buildIcosahedron();
  for (let i = 0; i < subdiv; i++) ({ verts, faces } = subdivide(verts, faces));

  // Push each vertex out along its direction by the lump field.
  const pts: V3[] = verts.map((v) => {
    const d = displace(v);
    return [v[0] * d, v[1] * d, v[2] * d];
  });

  // Non-indexed flat shading: one face normal shared by its three verts.
  const data = new Float32Array(faces.length * 3 * 6);
  let o = 0;
  for (const [a, b, c] of faces) {
    const pa = pts[a];
    const pb = pts[b];
    const pc = pts[c];
    const ux = pb[0] - pa[0];
    const uy = pb[1] - pa[1];
    const uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0];
    const vy = pc[1] - pa[1];
    const vz = pc[2] - pa[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const [fnx, fny, fnz] = norm([nx, ny, nz]);
    for (const p of [pa, pb, pc]) {
      data[o++] = p[0];
      data[o++] = p[1];
      data[o++] = p[2];
      data[o++] = fnx;
      data[o++] = fny;
      data[o++] = fnz;
    }
  }
  return { data, vertexCount: faces.length * 3 };
}

/**
 * Smooth unit sphere (no displacement), non-indexed with per-vertex smooth
 * normals (= the vertex direction). Used for the translucent ship shield bubble.
 */
export function makeSphereMesh(subdiv = 2): Mesh {
  let { verts, faces } = buildIcosahedron();
  for (let i = 0; i < subdiv; i++) ({ verts, faces } = subdivide(verts, faces));
  const data = new Float32Array(faces.length * 3 * 6);
  let o = 0;
  for (const [a, b, c] of faces) {
    for (const p of [verts[a], verts[b], verts[c]]) {
      // Unit sphere → position and normal are the same normalized vector.
      data[o++] = p[0];
      data[o++] = p[1];
      data[o++] = p[2];
      data[o++] = p[0];
      data[o++] = p[1];
      data[o++] = p[2];
    }
  }
  return { data, vertexCount: faces.length * 3 };
}

// Iñigo Quílez cosine palette → a smooth iridescent spectrum from a scalar in
// [0,1]; the three channels are phase-shifted so the sweep runs through the hues.
const iridescence = (t: number): V3 => [
  0.5 + 0.5 * Math.cos(2 * Math.PI * (t + 0.0)),
  0.5 + 0.5 * Math.cos(2 * Math.PI * (t + 0.33)),
  0.5 + 0.5 * Math.cos(2 * Math.PI * (t + 0.67)),
];

// The 100 triangle corners of the UV sphere as unit direction vectors: quads in
// the middle bands, single triangles at the poles.
function orbTris(stacks: number, slices: number): [V3, V3, V3][] {
  const dir = (i: number, j: number): V3 => {
    const theta = (Math.PI * i) / stacks; // 0 = north pole, π = south
    const phi = (2 * Math.PI * j) / slices;
    return [
      Math.sin(theta) * Math.cos(phi),
      Math.cos(theta),
      Math.sin(theta) * Math.sin(phi),
    ];
  };
  const tris: [V3, V3, V3][] = [];
  for (let i = 0; i < stacks; i++) {
    for (let j = 0; j < slices; j++) {
      const [a, b, c, d] = [
        dir(i, j),
        dir(i, j + 1),
        dir(i + 1, j),
        dir(i + 1, j + 1),
      ];
      if (i === 0)
        tris.push([a, c, d]); // north cap: a is the pole
      else if (i === stacks - 1)
        tris.push([a, b, c]); // south cap: c is the pole
      else tris.push([a, c, d], [a, d, b]);
    }
  }
  return tris;
}

/**
 * A faceted orb with exactly 100 triangular faces — a UV sphere at 6 stacks × 10
 * slices (2·slices·(stacks−1) = 100). Flat-shaded (one outward normal per face)
 * and non-indexed, and every vertex carries an iridescent colour keyed to its
 * height, so faces catch the light as distinct facets. It is the glowing core of
 * both bases and the center pad; the shader tints these vertex colours by the
 * team/phase hue (9 floats/vertex: pos, normal, rgb — see mesh-pass).
 */
export function makeFacetedOrbMesh(stacks = 6, slices = 10): Mesh {
  const tris = orbTris(stacks, slices);
  // On a unit sphere the face centroid already points outward → use it as the
  // flat normal. Vertex colour is the iridescent palette sampled by height.
  const data = new Float32Array(tris.length * 3 * 9);
  let o = 0;
  for (const [pa, pb, pc] of tris) {
    const [nx, ny, nz] = norm([
      (pa[0] + pb[0] + pc[0]) / 3,
      (pa[1] + pb[1] + pc[1]) / 3,
      (pa[2] + pb[2] + pc[2]) / 3,
    ]);
    for (const p of [pa, pb, pc]) {
      const [cr, cg, cb] = iridescence(0.5 + 0.5 * p[1]);
      data[o++] = p[0];
      data[o++] = p[1];
      data[o++] = p[2];
      data[o++] = nx;
      data[o++] = ny;
      data[o++] = nz;
      data[o++] = cr;
      data[o++] = cg;
      data[o++] = cb;
    }
  }
  return { data, vertexCount: tris.length * 3, hasColor: true };
}
