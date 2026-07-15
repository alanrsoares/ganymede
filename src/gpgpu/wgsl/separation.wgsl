// Separation force kernel — the P0 proof: mirror of steerSeparation's core
// O(n²) loop (omnidirectional ship personal-space, linear falloff). One thread
// per ship accumulates its own force, so there is NO cross-thread reduction and
// NO atomics. Reads positions (SoA vec4 for std430 alignment), writes a vec2
// force per ship. Depends on wrapDelta from lib.wgsl (composed in ahead of this).

struct Params {
  n: u32,
  arenaW: f32,
  arenaH: f32,
  r: f32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> force: array<vec2<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }

  let xi = pos[i].x;
  let yi = pos[i].y;
  let r2 = P.r * P.r;
  var s = vec2<f32>(0.0, 0.0);

  for (var j: u32 = 0u; j < P.n; j = j + 1u) {
    if (j == i) { continue; }
    let ax = wrapDelta(pos[j].x, xi, P.arenaW); // obstacle -> self
    let ay = wrapDelta(pos[j].y, yi, P.arenaH);
    let d2 = ax * ax + ay * ay;
    if (d2 >= r2 || d2 < 1e-6) { continue; }
    let dist = sqrt(d2);
    let w = (1.0 - dist / P.r) / dist; // linear falloff, matches CPU
    s = s + vec2<f32>(ax * w, ay * w);
  }
  force[i] = s;
}
