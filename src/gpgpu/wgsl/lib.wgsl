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

// Shared params for the spatial-hash grid and every kernel that queries it.
// numCellsX/Y tile the arena exactly (cellW = arenaW/numCellsX >= r), so a 3x3
// (toroidal) cell block around a ship is a conservative superset of all
// neighbours within r. Pure helpers below take fields explicitly (no binding)
// so both the grid builder and its consumers reuse them.
struct GridParams {
  n: u32,
  arenaW: f32,
  arenaH: f32,
  cellW: f32,
  cellH: f32,
  numCellsX: u32,
  numCellsY: u32,
  r: f32,
};

// Flat cell index for a position, clamped to the last cell on each axis (guards
// the x==arenaW / y==arenaH edge where floor would overflow the grid).
fn cellIndexOf(
  x: f32, y: f32, cellW: f32, cellH: f32, ncx: u32, ncy: u32,
) -> u32 {
  let cx = min(u32(floor(x / cellW)), ncx - 1u);
  let cy = min(u32(floor(y / cellH)), ncy - 1u);
  return cy * ncx + cx;
}

// Wrap a (possibly negative) cell axis coordinate into [0, n) toroidally.
fn wrapCell(v: i32, n: i32) -> u32 {
  return u32(((v % n) + n) % n);
}
