// Combined flocking kernel — the multi-term residency proof. One grid query
// (3×3 toroidal cell walk) accumulates THREE steer terms into a single force
// buffer, so a whole tick's neighbour work is one neighbour walk + one readback
// instead of one per term:
//   separation — omnidirectional repel from ALL ships within sepR (obstacle->self)
//   align      — steer heading toward same-team squad heading within flockR
//   cohere     — drift toward same-team squad centre within flockR
// Mirrors flockSteer's uncommitted (flock=1, no combat) core:
//   force = sep*sepGain + align*alignGain + cohere*cohereGain.
// posHead packs [x, y, dx, dy] (position + heading unit vec); velTeam packs
// [vx, vy, team, _] (team is a small int, exact in f32). Cell edge >= max(sepR,
// flockR) so the 3×3 block covers both radii. Uses GridParams + wrapDelta +
// wrapCell + normalizeOr from lib.wgsl.

struct FlockParams {
  sepR: f32,
  sepGain: f32,
  flockR: f32,
  alignGain: f32,
  cohereGain: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var<uniform> P: GridParams;
@group(0) @binding(1) var<storage, read> posHead: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read> cellCount: array<u32>;
@group(0) @binding(4) var<storage, read> sortedIdx: array<u32>;
@group(0) @binding(5) var<storage, read_write> force: array<vec2<f32>>;
@group(0) @binding(6) var<storage, read> velTeam: array<vec4<f32>>;
@group(0) @binding(7) var<uniform> F: FlockParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }

  let me = posHead[i];
  let xi = me.x;
  let yi = me.y;
  let hdx = me.z;
  let hdy = me.w;
  let teamI = velTeam[i].z;
  let sepR2 = F.sepR * F.sepR;
  let flockR2 = F.flockR * F.flockR;

  var sep = vec2<f32>(0.0, 0.0);
  var vsum = vec2<f32>(0.0, 0.0);
  var csum = vec2<f32>(0.0, 0.0);
  var cnt = 0.0;

  let cx = i32(min(u32(floor(xi / P.cellW)), P.numCellsX - 1u));
  let cy = i32(min(u32(floor(yi / P.cellH)), P.numCellsY - 1u));

  for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
    let gy = wrapCell(cy + dy, i32(P.numCellsY));
    for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
      let gx = wrapCell(cx + dx, i32(P.numCellsX));
      let c = gy * P.numCellsX + gx;
      let start = cellStart[c];
      let end = start + cellCount[c];
      for (var k: u32 = start; k < end; k = k + 1u) {
        let j = sortedIdx[k];
        if (j == i) { continue; }
        let oj = posHead[j];

        // Separation: repel from every ship within sepR (obstacle -> self).
        let sx = wrapDelta(oj.x, xi, P.arenaW);
        let sy = wrapDelta(oj.y, yi, P.arenaH);
        let sd2 = sx * sx + sy * sy;
        if (sd2 > 1e-6 && sd2 < sepR2) {
          let dist = sqrt(sd2);
          let w = (1.0 - dist / F.sepR) / dist;
          sep = sep + vec2<f32>(sx * w, sy * w);
        }

        // Align + cohere: same-team squadmates within flockR (self -> neighbour).
        let vt = velTeam[j];
        if (vt.z == teamI) {
          let ox = wrapDelta(xi, oj.x, P.arenaW);
          let oy = wrapDelta(yi, oj.y, P.arenaH);
          if (ox * ox + oy * oy <= flockR2) {
            vsum = vsum + vec2<f32>(vt.x, vt.y);
            csum = csum + vec2<f32>(ox, oy);
            cnt = cnt + 1.0;
          }
        }
      }
    }
  }

  var f = sep * F.sepGain;
  if (cnt > 0.0) {
    let avgH = normalizeOr(vsum / cnt, hdx, hdy);
    f = f + (avgH - vec2<f32>(hdx, hdy)) * F.alignGain; // align
    f = f + (csum / cnt) * F.cohereGain; // cohere
  }
  force[i] = f;
}
