// Grid-accelerated separation — same force as separation.wgsl (omnidirectional
// personal-space, linear falloff) but O(n·k) instead of O(n²): each ship only
// visits the ships in its own cell and the 8 toroidal neighbours. Reads the
// spatial-hash grid built by grid.wgsl (cellStart + cellCount + sortedIdx).
// cellCount is bound read-only here (all atomic writes finished in prior passes)
// — atomic<u32> and u32 share layout, so the same buffer views cleanly. Uses
// GridParams + cellIndexOf/wrapCell from lib.wgsl (composed in ahead).

@group(0) @binding(0) var<uniform> P: GridParams;
@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read> cellCount: array<u32>;
@group(0) @binding(4) var<storage, read> sortedIdx: array<u32>;
@group(0) @binding(5) var<storage, read_write> force: array<vec2<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }

  let xi = pos[i].x;
  let yi = pos[i].y;
  let r2 = P.r * P.r;
  var s = vec2<f32>(0.0, 0.0);

  let cx = i32(min(u32(floor(xi / P.cellW)), P.numCellsX - 1u));
  let cy = i32(min(u32(floor(yi / P.cellH)), P.numCellsY - 1u));
  let ncx = i32(P.numCellsX);
  let ncy = i32(P.numCellsY);

  for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
    let gy = wrapCell(cy + dy, ncy);
    for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
      let gx = wrapCell(cx + dx, ncx);
      let c = gy * P.numCellsX + gx;
      let start = cellStart[c];
      let end = start + cellCount[c];
      for (var k: u32 = start; k < end; k = k + 1u) {
        let j = sortedIdx[k];
        if (j == i) { continue; }
        let ax = wrapDelta(pos[j].x, xi, P.arenaW); // obstacle -> self
        let ay = wrapDelta(pos[j].y, yi, P.arenaH);
        let d2 = ax * ax + ay * ay;
        if (d2 >= r2 || d2 < 1e-6) { continue; }
        let dist = sqrt(d2);
        let w = (1.0 - dist / P.r) / dist; // linear falloff, matches CPU
        s = s + vec2<f32>(ax * w, ay * w);
      }
    }
  }
  force[i] = s;
}
