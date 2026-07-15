// Cross-set candidate-pair kernel — the P6 broad-phase for projectiles/hazards.
// P5 self-pairs ONE set (ship×ship, dedup j>i); here two DIFFERENT sets are
// paired: set B (bullets / missiles / shrapnel) queried against a grid built
// over set A (ships / rocks). Every thread owns one B-element, walks the A-grid
// 3×3 block, and emits (bIdx, aIdx) for each A within the query radius. No dedup
// guard (the sets are disjoint, each pair is seen once by its B thread).
//
// Same hybrid split as P5: this is a fixed-radius broad-phase (r = the max over
// per-pair hit radii, e.g. BULLET_RADIUS + max shipRadius). The CPU narrow-phase
// applies the exact per-pair `within(rad)` and the authoritative mutation, so
// the golden tests stay green. Grid built over A, so sortedIdx indexes posA.
// P.n = A count; Q.mCount = B count (the dispatch size).

struct QCap { maxPairs: u32, mCount: u32 };

@group(0) @binding(0) var<uniform> P: GridParams;
@group(0) @binding(1) var<storage, read> posA: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read> cellCount: array<u32>;
@group(0) @binding(4) var<storage, read> sortedIdx: array<u32>;
@group(0) @binding(5) var<storage, read> posB: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> pairCount: atomic<u32>;
@group(0) @binding(7) var<storage, read_write> pairs: array<vec2<u32>>;
@group(0) @binding(8) var<uniform> Q: QCap;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let b = gid.x;
  if (b >= Q.mCount) { return; }

  let bp = posB[b];
  let r2 = P.r * P.r;
  let cx = i32(min(u32(floor(bp.x / P.cellW)), P.numCellsX - 1u));
  let cy = i32(min(u32(floor(bp.y / P.cellH)), P.numCellsY - 1u));

  for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
    let gy = wrapCell(cy + dy, i32(P.numCellsY));
    for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
      let gx = wrapCell(cx + dx, i32(P.numCellsX));
      let c = gy * P.numCellsX + gx;
      let start = cellStart[c];
      let end = start + cellCount[c];
      for (var k: u32 = start; k < end; k = k + 1u) {
        let j = sortedIdx[k];
        let ox = wrapDelta(bp.x, posA[j].x, P.arenaW);
        let oy = wrapDelta(bp.y, posA[j].y, P.arenaH);
        if (ox * ox + oy * oy >= r2) { continue; }
        let slot = atomicAdd(&pairCount, 1u);
        if (slot < Q.maxPairs) { pairs[slot] = vec2<u32>(b, j); }
      }
    }
  }
}
