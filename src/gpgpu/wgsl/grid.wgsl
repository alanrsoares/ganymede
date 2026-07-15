// Spatial-hash broad-phase — the reusable O(n) neighbour primitive every
// neighbour kernel (separation, align/cohere, pickFoe, ship-collisions,
// projectiles) builds on. Four passes per tick, sharing GridParams + the pure
// cell helpers from lib.wgsl (composed in ahead of this):
//
//   clear   — zero every cell counter.
//   count   — each ship atomicAdd's 1 into its cell's counter.
//   scan    — exclusive prefix-sum over counters -> per-cell start offset, and
//             seed the scatter cursor. Serial single-invocation: the cell count
//             (~hundreds) is tiny and this runs once/tick, dwarfed by count/
//             scatter's O(n). Upgrade to a parallel scan only if C grows large.
//   scatter — each ship writes its id into sorted[cursor++] (atomic bump).
//
// Sorting ids by cell makes a neighbour query's candidate order deterministic
// per-device. cellCount/cellStart/cursor are length C = numCellsX*numCellsY;
// sortedIdx is length n.

@group(0) @binding(0) var<uniform> P: GridParams;
@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(4) var<storage, read_write> cursor: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> sortedIdx: array<u32>;

@compute @workgroup_size(64)
fn clear(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= P.numCellsX * P.numCellsY) { return; }
  atomicStore(&cellCount[c], 0u);
}

@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let c = cellIndexOf(
    pos[i].x, pos[i].y, P.cellW, P.cellH, P.numCellsX, P.numCellsY,
  );
  atomicAdd(&cellCount[c], 1u);
}

@compute @workgroup_size(1)
fn scan() {
  let C = P.numCellsX * P.numCellsY;
  var acc: u32 = 0u;
  for (var c: u32 = 0u; c < C; c = c + 1u) {
    cellStart[c] = acc;
    atomicStore(&cursor[c], acc);
    acc = acc + atomicLoad(&cellCount[c]);
  }
}

@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let c = cellIndexOf(
    pos[i].x, pos[i].y, P.cellW, P.cellH, P.numCellsX, P.numCellsY,
  );
  let slot = atomicAdd(&cursor[c], 1u);
  sortedIdx[slot] = i;
}
