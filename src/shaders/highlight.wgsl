// Selected-part highlight for the drydock hull designer: the selected part's
// mesh re-drawn as a slightly inflated additive shell, pulsing acid green.
// Depth test is disabled so the glow reads through the hull — occluded parts
// (an underslung mine bay, an engine) stay findable while editing. Same
// instance layout and transform as ship.wgsl.

struct Uniforms {
  resolution: vec2f,
  time: f32,
  depthScale: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
  @location(0) inst_loc: vec4f, // [cx, cy, radius(px), roll]
  @location(1) inst_att: vec4f, // [heading, tilt, wavePhase, bendCurve]
  @location(2) inst_art: vec4f, // articulation row — unused (design mode is
                                // rest pose; ship.wgsl documents the fields)
  @location(6) pos: vec3f,
  @location(7) nrm: vec3f,
  @location(8) col: vec3f,      // present in hull meshes; unused here
}

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
}

fn shipMat(heading: f32, tilt: f32, roll: f32) -> mat3x3f {
  let ch = cos(heading); let sh = sin(heading);
  let ct = cos(tilt);    let st = sin(tilt);
  let cr = cos(roll);    let sr = sin(roll);
  let rz = mat3x3f(ch, sh, 0, -sh, ch, 0, 0, 0, 1);
  let rx = mat3x3f(1, 0, 0, 0, ct, st, 0, -st, ct);
  let ry = mat3x3f(cr, 0, -sr, 0, 1, 0, sr, 0, cr);
  return rz * rx * ry;
}

@vertex
fn vs(in: VSIn) -> VSOut {
  let R = shipMat(in.inst_att.x, in.inst_att.y, in.inst_loc.w);
  // Inflate along the face normal so the shell rims the part.
  let local = in.pos + in.nrm * 0.03;
  let p = R * (local * in.inst_loc.z);

  let wx = in.inst_loc.x + p.x;
  let wy = in.inst_loc.y + p.y;
  let ndcx = wx / u.resolution.x * 2.0 - 1.0;
  let ndcy = -(wy / u.resolution.y * 2.0 - 1.0);
  let z = clamp(0.5 - p.z * u.depthScale, 0.0, 1.0);

  var out: VSOut;
  out.position = vec4f(ndcx, ndcy, z, 1.0);
  out.normal = R * in.nrm;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let N = normalize(in.normal);
  // Rim-weighted so the glow outlines rather than floods; slow pulse.
  let rim = 0.35 + 0.65 * pow(1.0 - abs(N.z), 1.5);
  let pulse = 0.6 + 0.4 * sin(u.time * 5.0);
  return vec4f(vec3f(0.45, 1.0, 0.25) * rim * pulse * 0.45, 1.0);
}
