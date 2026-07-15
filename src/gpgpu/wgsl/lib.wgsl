// Shared GPGPU device functions — a mirror of src/engine/physics.ts so GPU
// kernels compute the same quantities as the CPU sim. No bindings live here;
// this text is composed (prepended) into each kernel module via `compose()`.

// Signed shortest delta from `a` to `b` on a wrapped axis, in [-limit/2, limit/2].
fn wrapDelta(a: f32, b: f32, limit: f32) -> f32 {
  var dv = b - a;
  if (dv > limit * 0.5) { dv = dv - limit; }
  else if (dv < -limit * 0.5) { dv = dv + limit; }
  return dv;
}

// Minimum toroidal distance across a wrapped axis.
fn toroidalDist(a: f32, b: f32, limit: f32) -> f32 {
  let diff = abs(a - b);
  return select(diff, limit - diff, diff > limit * 0.5);
}

// Grid cell coordinates for the spatial-hash broad-phase (P2). `cell` is the
// cell edge length in field units.
fn cellCoord(x: f32, y: f32, cell: f32) -> vec2<u32> {
  return vec2<u32>(u32(floor(x / cell)), u32(floor(y / cell)));
}
