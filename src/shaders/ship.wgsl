// 3D ship-hull mesh pass. Hulls are instanced procedural part-assemblies
// (hull/bake.ts) positioned in screen pixels like rocks, with three ship
// rotations: heading (screen-plane), a fixed camera tilt that leans the hull
// so its 3D form reads under the top-down camera, and roll for continuous
// banking (replaces the 5-frame sprite bank flip). Shares the frame uniform
// layout with the other passes: resolution .xy, time .z, depth scale .w.

struct Uniforms {
  resolution: vec2f,
  time: f32,
  depthScale: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
  @location(0) inst_loc: vec4f, // [cx, cy, radius(px), roll]
  @location(1) inst_att: vec4f, // [heading, tilt, _, _]
  @location(2) inst_col: vec4f, // team tint rgb + master alpha (cloak)
  @location(6) pos: vec3f,      // mesh vertex (fixed loc, see mesh-pass.ts)
  @location(7) nrm: vec3f,      // flat face normal
  @location(8) col: vec3f,      // baked part colour; components > 1 = emissive
}

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec4f,
  @location(2) baseCol: vec3f,
  @location(3) localPos: vec3f,
}

// heading about Z (screen plane, y-down), tilt about X, roll about Y (the
// ship's forward axis) — applied Rz(heading) * Rx(tilt) * Ry(roll).
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
  let p = R * (in.pos * in.inst_loc.z);
  let n = R * in.nrm;

  let wx = in.inst_loc.x + p.x;
  let wy = in.inst_loc.y + p.y;
  let wz = p.z; // + toward viewer

  let ndcx = wx / u.resolution.x * 2.0 - 1.0;
  let ndcy = -(wy / u.resolution.y * 2.0 - 1.0);
  let z = clamp(0.5 - wz * u.depthScale, 0.0, 1.0);

  var out: VSOut;
  out.position = vec4f(ndcx, ndcy, z, 1.0);
  out.normal = n;
  out.color = in.inst_col;
  out.baseCol = in.col;
  out.localPos = in.pos;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let N = normalize(in.normal);
  let L = normalize(vec3f(-0.4, -0.55, 0.75)); // same key light as rock.wgsl
  let V = vec3f(0.0, 0.0, 1.0);

  let diff = max(dot(N, L), 0.0);
  let amb = 0.22;
  let R_refl = reflect(-L, N);
  let spec = pow(max(dot(R_refl, V), 0.0), 16.0) * 0.35;
  let rim = pow(1.0 - max(N.z, 0.0), 3.0) * 0.25;

  // Team tint: near-white multiply (k = 0.55), the same read the sprite
  // hulls had — carapace keeps its bone/void palette, team hue soaks in.
  let k = 0.55;
  let tint = (1.0 - k) + k * in.color.rgb;

  // Emissive parts (baked colour components > 1) skip the lambert term and
  // breathe slowly — polyps and the eye pulse like something alive.
  let emissive = max(max(in.baseCol.r, in.baseCol.g), in.baseCol.b) > 1.0;
  if (emissive) {
    let pulse = 0.82 + 0.18 * sin(u.time * 2.6 + in.localPos.y * 3.0);
    return vec4f(in.baseCol * tint * pulse, in.color.a);
  }

  let shade = in.baseCol * tint * (amb + diff * 0.95) + vec3f(rim) + vec3f(spec);
  return vec4f(shade, in.color.a);
}
