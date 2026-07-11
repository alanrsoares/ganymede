// Pure 2D collision physics on a toroidal (wrapped) field. Operates on plain
// velocity vectors; callers map their own heading/speed representation in and
// out. No state, no clock — just math, so it stays inside the pure Elm `update`.

export type Vec2 = readonly [number, number];

/** Signed shortest delta from `a` to `b` on a wrapped axis, in [-limit/2, limit/2]. */
export const wrapDelta = (a: number, b: number, limit: number): number => {
  let dv = b - a;
  if (dv > limit / 2) dv -= limit;
  else if (dv < -limit / 2) dv += limit;
  return dv;
};

const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const len = (v: Vec2): number => Math.hypot(v[0], v[1]);

/** Unit vector, or `fallback` when the input has ~zero length. */
export const normalize = (v: Vec2, fallback: Vec2 = [0, 1]): Vec2 => {
  const l = len(v);
  return l < 1e-6 ? fallback : [v[0] / l, v[1] / l];
};

/** Heading angle of a velocity, matching the sim's atan2(x, y) convention. */
export const angleTo = (v: Vec2): number => Math.atan2(v[0], v[1]);

/** Rotate a vector by `a` radians (CCW). Used to curve drifting bodies. */
export const rotate = (v: Vec2, a: number): Vec2 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
};

/** Ease `current` toward `target` by `t` along the shortest arc (radians). */
export const easeAngle = (
  current: number,
  target: number,
  t: number,
): number => {
  let d = target - current;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return current + d * t;
};

/**
 * Resolve a 2D elastic collision between two bodies. Returns their post-impact
 * velocities. `normal` points from a to b (need not be unit). Masses default to
 * equal (a straight velocity swap along the normal). No-op when the bodies are
 * already separating, so a lingering overlap can't inject repeated impulses.
 */
export const elastic = (
  va: Vec2,
  vb: Vec2,
  normal: Vec2,
  ma = 1,
  mb = 1,
): [Vec2, Vec2] => {
  const nl = len(normal);
  if (nl === 0) return [va, vb];
  const n: Vec2 = [normal[0] / nl, normal[1] / nl];
  const van = dot(va, n);
  const vbn = dot(vb, n);
  if (van <= vbn) return [va, vb]; // separating already
  const sum = ma + mb;
  const van2 = (van * (ma - mb) + 2 * mb * vbn) / sum;
  const vbn2 = (vbn * (mb - ma) + 2 * ma * van) / sum;
  return [
    [va[0] + (van2 - van) * n[0], va[1] + (van2 - van) * n[1]],
    [vb[0] + (vbn2 - vbn) * n[0], vb[1] + (vbn2 - vbn) * n[1]],
  ];
};
