// Procedural asteroid mesh: a subdivided icosphere displaced by a few sinusoidal
// lumps, then expanded to a non-indexed triangle list with per-face (flat)
// normals so it reads as a chunk of faceted rock rather than a smooth ball.
// Built once at startup on the CPU; the GPU just instances it per asteroid.

export interface Mesh {
  /** Interleaved [px, py, pz, nx, ny, nz] per vertex. */
  readonly data: Float32Array;
  readonly vertexCount: number;
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
const subdivide = (
  verts: V3[],
  faces: [number, number, number][],
): { verts: V3[]; faces: [number, number, number][] } => {
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
};

// Deterministic lumpiness from a unit direction — a few out-of-phase sinusoids.
const displace = ([x, y, z]: V3): number =>
  1 +
  0.2 * Math.sin(x * 3.1 + y * 2.3) +
  0.13 * Math.sin(y * 4.2 - z * 1.7) +
  0.1 * Math.cos(z * 5.1 + x * 2.9) +
  0.06 * Math.sin(x * 7.3 + z * 6.1);

/** Build the faceted asteroid mesh (subdiv 2 → 320 faces → 960 verts). */
export const makeAsteroidMesh = (subdiv = 2): Mesh => {
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
};

/**
 * Smooth unit sphere (no displacement), non-indexed with per-vertex smooth
 * normals (= the vertex direction). Used for the translucent ship shield bubble.
 */
export const makeSphereMesh = (subdiv = 2): Mesh => {
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
};

/** A faceted 3D double-cone / crystal structure. */
export const makeCrystalMesh = (): Mesh => {
  const N = 8;
  const verts: V3[] = [];
  for (let i = 0; i < N; i++) {
    const angle = (i * Math.PI * 2) / N;
    verts.push([Math.cos(angle), Math.sin(angle), 0]);
  }
  verts.push([0, 0, 1.4]); // top
  verts.push([0, 0, -1.4]); // bottom

  const topIdx = N;
  const botIdx = N + 1;
  const faces: [number, number, number][] = [];
  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    faces.push([topIdx, i, next]);
    faces.push([i, botIdx, next]);
  }

  const data = new Float32Array(faces.length * 3 * 6);
  let o = 0;
  for (const [a, b, c] of faces) {
    const pa = verts[a];
    const pb = verts[b];
    const pc = verts[c];
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
};

/** A faceted 3D torus ring. */
export const makeTorusMesh = (
  radialSegments = 12,
  tubularSegments = 8,
  radius = 1.0,
  tube = 0.35,
): Mesh => {
  const verts: V3[] = [];
  const faces: [number, number, number][] = [];

  for (let j = 0; j <= radialSegments; j++) {
    const theta = (j * Math.PI * 2) / radialSegments;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);

    for (let i = 0; i <= tubularSegments; i++) {
      const phi = (i * Math.PI * 2) / tubularSegments;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);

      const x = (radius + tube * cosPhi) * cosTheta;
      const y = (radius + tube * cosPhi) * sinTheta;
      const z = tube * sinPhi;
      verts.push([x, y, z]);
    }
  }

  for (let j = 0; j < radialSegments; j++) {
    for (let i = 0; i < tubularSegments; i++) {
      const a = j * (tubularSegments + 1) + i;
      const b = j * (tubularSegments + 1) + i + 1;
      const c = (j + 1) * (tubularSegments + 1) + i;
      const d = (j + 1) * (tubularSegments + 1) + i + 1;

      faces.push([a, b, c]);
      faces.push([b, d, c]);
    }
  }

  const data = new Float32Array(faces.length * 3 * 6);
  let o = 0;
  for (const [a, b, c] of faces) {
    const pa = verts[a];
    const pb = verts[b];
    const pc = verts[c];
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
};
