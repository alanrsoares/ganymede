// Spatial-hash broad-phase — SKELETON (wired in P2, not P0).
//
// Plan: replace the O(n²) neighbour scan with an O(n·k) grid query, the reusable
// primitive every neighbour kernel (separation, align/cohere, pickFoe,
// ship-collisions, projectiles) will build on. Three passes:
//
//   1. count   — each ship atomicAdd's 1 into its cell's counter.
//   2. prefix  — exclusive prefix-sum over cell counters → per-cell start offset.
//   3. scatter — each ship writes its id into sorted[offset++] (atomic bump).
//
// A neighbour query then walks the 3×3 (toroidal) cell block around a ship and
// iterates only the ids in `sorted` for those cells. Sorting by cell makes the
// candidate order deterministic per-device. Cell edge = max interaction radius
// so the 3×3 block is a conservative superset of every in-range neighbour.
//
// Left as a documented stub so P0 stays a single-kernel proof; `cellCoord` in
// lib.wgsl is the shared entry point this will consume.
