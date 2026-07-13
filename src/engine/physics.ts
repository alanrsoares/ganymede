// Pure 2D collision physics on a toroidal (wrapped) field. Operates on plain
// velocity vectors; callers map their own heading/speed representation in and
// out. No state, no clock — just math, so it stays inside the pure Elm `update`.

export type Vec2 = readonly [number, number];

/** Clamp a scalar to [0, 1] — the common fill-fraction / alpha guard. */
export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Linear interpolate from `a` to `b` by `k` (unclamped). */
export const lerp = (a: number, b: number, k: number): number =>
  a + (b - a) * k;

/** Signed shortest delta from `a` to `b` on a wrapped axis, in [-limit/2, limit/2]. */
export const wrapDelta = (a: number, b: number, limit: number): number => {
  let dv = b - a;
  if (dv > limit / 2) dv -= limit;
  else if (dv < -limit / 2) dv += limit;
  return dv;
};
export const wrap = (v: number, limit: number): number =>
  ((v % limit) + limit) % limit;

/** Minimum toroidal distance across a wrapped axis. */
export function toroidalDist(a: number, b: number, limit: number): number {
  const diff = Math.abs(a - b);
  return diff > limit / 2 ? limit - diff : diff;
}

const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const len = (v: Vec2): number => Math.hypot(v[0], v[1]);

/** Unit vector, or `fallback` when the input has ~zero length. */
export function normalize(v: Vec2, fallback: Vec2 = [0, 1]): Vec2 {
  const l = len(v);
  return l < 1e-6 ? fallback : [v[0] / l, v[1] / l];
}

/** Heading angle of a velocity, matching the sim's atan2(x, y) convention. */
export const angleTo = (v: Vec2): number => Math.atan2(v[0], v[1]);

/** Rotate a vector by `a` radians (CCW). Used to curve drifting bodies. */
export function rotate(v: Vec2, a: number): Vec2 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

/** Ease `current` toward `target` by `t` along the shortest arc (radians). */
export function easeAngle(current: number, target: number, t: number): number {
  let d = target - current;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return current + d * t;
}

/**
 * Bounce a moving body off a static disc on the wrapped field. Mutates `pos`:
 * pushes it out of overlap and reflects its velocity about the contact normal
 * (only when closing, so a lingering overlap can't re-bounce). Returns the
 * center distance, the pre-bounce normal velocity (`vdot`, for the caller's
 * damage gate), and the combined contact radius. A no-op (vdot -1) when the
 * body isn't overlapping the disc. Field dimensions are passed in so this stays
 * game-agnostic.
 */
export function reflectOffDisc(
  pos: { x: number; y: number; vx: number; vy: number },
  cx: number,
  cy: number,
  discRad: number,
  bodyRad: number,
  w: number,
  h: number,
): { dist: number; vdot: number; rad: number } {
  const nx = wrapDelta(pos.x, cx, w);
  const ny = wrapDelta(pos.y, cy, h);
  const rad = discRad + bodyRad;
  const dist = Math.hypot(nx, ny);
  if (dist >= rad || dist < 1e-3) return { dist, vdot: -1, rad };
  const ux = nx / dist;
  const uy = ny / dist;
  pos.x = wrap(pos.x - ux * (rad - dist), w);
  pos.y = wrap(pos.y - uy * (rad - dist), h);
  const vdot = pos.vx * ux + pos.vy * uy;
  if (vdot > 0) {
    pos.vx -= 2 * vdot * ux;
    pos.vy -= 2 * vdot * uy;
  }
  return { dist, vdot, rad };
}

/**
 * Resolve a 2D elastic collision between two bodies. Returns their post-impact
 * velocities. `normal` points from a to b (need not be unit). Masses default to
 * equal (a straight velocity swap along the normal). No-op when the bodies are
 * already separating, so a lingering overlap can't inject repeated impulses.
 */
export function elastic(
  va: Vec2,
  vb: Vec2,
  normal: Vec2,
  ma = 1,
  mb = 1,
): [Vec2, Vec2] {
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
}
