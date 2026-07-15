// Candidate-pair kernel — the hybrid broad-phase (P5). The GPU spatial grid
// enumerates every ship pair within the collision band; the CPU keeps the
// authoritative, MUTATING narrow-phase (bounce / dogfight / resource exchange /
// deaths) so the sim stays deterministic and the existing golden tests pass.
//
// Unlike pursuit (near arena-scale radius, no grid), the ship-collision band is
// short (SEMITOUCH ~22px), so the grid applies cleanly: cell edge >= r means a
// 3x3 toroidal cell block is a conservative superset of the neighbours within r.
//
// Each thread owns ship i and walks its 3x3 block, emitting the ordered pair
// (i, j) for every neighbour j > i within r (the j > i guard dedups the pair
// that thread j would also see). Pairs are appended to a shared list via an
// atomic cursor; the CPU sorts them back into (i, j) lexicographic order and
// replays exactly the nested-loop visit order, so resolution is unchanged.
// r (the band) rides in GridParams.r (the grid is configured with r = SEMITOUCH).

struct Cap { maxPairs: u32 };

@group(0) @binding(0) var<uniform> P: GridParams;
@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read> cellCount: array<u32>;
@group(0) @binding(4) var<storage, read> sortedIdx: array<u32>;
@group(0) @binding(5) var<storage, read_write> pairCount: atomic<u32>;
@group(0) @binding(6) var<storage, read_write> pairs: array<vec2<u32>>;
@group(0) @binding(7) var<uniform> C: Cap;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }

  let pi = pos[i];
  let r2 = P.r * P.r;
  let cx = i32(min(u32(floor(pi.x / P.cellW)), P.numCellsX - 1u));
  let cy = i32(min(u32(floor(pi.y / P.cellH)), P.numCellsY - 1u));

  for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
    let gy = wrapCell(cy + dy, i32(P.numCellsY));
    for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
      let gx = wrapCell(cx + dx, i32(P.numCellsX));
      let c = gy * P.numCellsX + gx;
      let start = cellStart[c];
      let end = start + cellCount[c];
      for (var k: u32 = start; k < end; k = k + 1u) {
        let j = sortedIdx[k];
        if (j <= i) { continue; } // ordered + dedup: only j > i
        let ox = wrapDelta(pi.x, pos[j].x, P.arenaW);
        let oy = wrapDelta(pi.y, pos[j].y, P.arenaH);
        if (ox * ox + oy * oy >= r2) { continue; }
        let slot = atomicAdd(&pairCount, 1u);
        if (slot < C.maxPairs) { pairs[slot] = vec2<u32>(i, j); }
      }
    }
  }
}
