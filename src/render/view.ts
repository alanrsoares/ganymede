// One shared view-projection matrix: world pixels → clip space. Every render
// pass takes it as a uniform instead of doing its own `wx / resolution * 2 - 1`,
// so a later camera (scroll follow, a shallow pitch) is a matrix to write per
// frame rather than a refactor across nine shaders.
//
// `orthoPixels` is the identity case — exactly the transform the passes had
// hardcoded: x right, y down, +z toward the viewer compressed into the [0,1]
// depth band. The renderer writes it every frame; nothing moves until something
// writes a different one.

/** 16 floats, column-major — the layout WGSL expects for a `mat4x4f` uniform. */
export type ViewProj = Float32Array;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Column-major, so element [col * 4 + row]: columns are the basis vectors WGSL
// multiplies against, and the fourth column is the translation.
export const orthoPixels = (
  w: number,
  h: number,
  depthScale: number,
): ViewProj =>
  new Float32Array([
    2 / w,
    0,
    0,
    0,
    0,
    -2 / h,
    0,
    0,
    0,
    0,
    -depthScale,
    0,
    -1,
    1,
    0.5,
    1,
  ]);

/** World pixels → normalised device coords (the perspective divide included). */
export const project = (m: ViewProj, x: number, y: number, z = 0): Vec3 => {
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  const iw = cw === 0 ? 0 : 1 / cw;
  return {
    x: (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw,
    y: (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw,
    z: (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw,
  };
};

/**
 * NDC → world pixels on the z = 0 plane: the inverse of `project` for the plane
 * every pointer hit-test cares about. Solves the 2x2 xy system directly rather
 * than inverting the whole matrix — correct for any affine view (translate,
 * scale, rotate, shear); a true perspective row would need the full inverse.
 */
export const unproject = (m: ViewProj, ndcx: number, ndcy: number): Vec3 => {
  const a = m[0];
  const b = m[4];
  const c = m[1];
  const d = m[5];
  const det = a * d - b * c;
  if (det === 0) return { x: 0, y: 0, z: 0 };
  const px = ndcx - m[12];
  const py = ndcy - m[13];
  return { x: (px * d - b * py) / det, y: (a * py - px * c) / det, z: 0 };
};

/** CSS pixels (pointer coords) → world pixels, via NDC so the view applies. */
export const screenToWorld = (
  m: ViewProj,
  sx: number,
  sy: number,
  cssW: number,
  cssH: number,
): Vec3 => unproject(m, (sx / cssW) * 2 - 1, -((sy / cssH) * 2 - 1));

/** World pixels → CSS pixels, for anchoring DOM/HUD chrome to a sim entity. */
export const worldToScreen = (
  m: ViewProj,
  x: number,
  y: number,
  cssW: number,
  cssH: number,
  z = 0,
): { x: number; y: number } => {
  const ndc = project(m, x, y, z);
  return { x: ((ndc.x + 1) / 2) * cssW, y: ((1 - ndc.y) / 2) * cssH };
};
