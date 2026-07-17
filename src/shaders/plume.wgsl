// Additive engine-plume pass. One unit cone (hull/bake.ts makePlumeMesh)
// instanced per engine nozzle: positioned in ship-local space, carried through
// the same heading/tilt/roll transform as the hull (ship.wgsl), scaled by
// throttle, and flickered per-ship so the fleet never strobes in unison.
// Blended additively with no depth write; the hull still occludes it.

struct Uniforms {
  resolution: vec2f,
  time: f32,
  depthScale: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
  @location(0) inst_loc: vec4f, // [cx, cy, radius(px), roll]
  @location(1) inst_att: vec4f, // [heading, tilt, throttle, phase]
  @location(2) inst_noz: vec4f, // nozzle offset in ship-local units, .w plume width
  @location(3) inst_col: vec4f, // team tail tint + master alpha
  @location(6) pos: vec3f,
  @location(7) nrm: vec3f,
}

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) localPos: vec3f,
  @location(2) throttle: f32,
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
  let throttle = in.inst_att.z;
  // Fast per-ship flicker: length breathes, width shivers slightly.
  let flick = 1.0 + 0.22 * sin(u.time * 27.0 + in.inst_att.w)
                  + 0.09 * sin(u.time * 61.0 + in.inst_att.w * 2.3);
  let len = (0.55 + 1.05 * throttle) * flick;
  let w = in.inst_noz.w * (0.9 + 0.2 * flick);

  let local = vec3f(in.pos.x * w, in.pos.y * len, in.pos.z * w) + in.inst_noz.xyz;
  let R = shipMat(in.inst_att.x, in.inst_att.y, in.inst_loc.w);
  let p = R * (local * in.inst_loc.z);

  let wx = in.inst_loc.x + p.x;
  let wy = in.inst_loc.y + p.y;
  let ndcx = wx / u.resolution.x * 2.0 - 1.0;
  let ndcy = -(wy / u.resolution.y * 2.0 - 1.0);
  let z = clamp(0.5 - p.z * u.depthScale, 0.0, 1.0);

  var out: VSOut;
  out.position = vec4f(ndcx, ndcy, z, 1.0);
  out.color = in.inst_col;
  out.localPos = in.pos;
  out.throttle = throttle;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  // t: 0 at the nozzle ring -> 1 at the tip.
  let t = clamp(-in.localPos.y, 0.0, 1.0);
  // Acid-hot core at the nozzle bleeding into the team tint down the tail —
  // same read as the sprite trail (hot head, team-coloured wake).
  let core = vec3f(0.85, 1.0, 0.55);
  let acid = vec3f(0.45, 1.0, 0.18);
  let body = mix(core, mix(acid, in.color.rgb, 0.55), pow(t, 0.6));
  let fade = pow(1.0 - t, 1.7) * (0.35 + 0.65 * in.throttle);
  return vec4f(body * fade * in.color.a, 1.0);
}
