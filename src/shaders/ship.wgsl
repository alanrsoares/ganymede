// 3D ship-hull mesh pass. Hulls are instanced procedural part-assemblies
// (hull/bake.ts) positioned in screen pixels like rocks, with three ship
// rotations: heading (screen-plane), a fixed camera tilt that leans the hull
// so its 3D form reads under the top-down camera, and roll for continuous
// banking (replaces the 5-frame sprite bank flip). Shares the frame uniform
// layout with the other passes: resolution .xy, time .z, depth scale .w.

struct Uniforms {
  resolution: vec2f,
  time: f32,
  _pad: f32,
  // World pixels -> clip space. Shared by every pass (see render/view.ts);
  // identity ortho today, so the depth scale it folds in is the old one.
  viewProj: mat4x4f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
  @location(0) inst_loc: vec4f, // [cx, cy, radius(px), roll]
  @location(1) inst_att: vec4f, // [heading, tilt, wavePhase, bendCurve]
  @location(2) inst_art: vec4f, // [amp, freq, headStiff, segLen]
  @location(3) inst_col: vec4f, // team tint rgb + master alpha (cloak)
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

// Spine articulation: a travelling lateral wave nose→tail plus a parabolic
// turn lean, both zero forward of headStiff. Returns [offset, slope] — the
// x displacement at spine coordinate y and its d/dy for the normal fix.
// Mirror of hull/articulation.ts spineOffset — keep in sync.
fn spineDeform(y: f32, phase: f32, curve: f32, art: vec4f) -> vec2f {
  let amp = art.x; let freq = art.y; let headStiff = art.z; let segLen = art.w;
  // segLen > 0: hinge mode — snap to segment centres so plates stay rigid.
  let yq = select(y, (floor(y / segLen) + 0.5) * segLen, segLen > 0.0);
  // Envelope 0 at head → 1 at the tail (-1.1). Explicit clamp+hermite: the
  // edges are reversed, so spell smoothstep out rather than rely on it.
  let t = clamp((yq - headStiff) / (-1.1 - headStiff), 0.0, 1.0);
  let env = t * t * (3.0 - 2.0 * t);
  let d = headStiff - yq;
  let aft = step(yq, headStiff);
  let offset = sin(yq * freq - phase) * amp * env + curve * d * d * aft;
  let slope = cos(yq * freq - phase) * amp * freq * env - 2.0 * curve * d * aft;
  return vec2f(offset, slope);
}

@vertex
fn vs(in: VSIn) -> VSOut {
  let ds = spineDeform(in.pos.y, in.inst_att.z, in.inst_att.w, in.inst_art);
  var lp = in.pos;
  lp.x += ds.x;
  // Small-angle Rz(atan(slope)) on the normal — enough for flat shading.
  let ln = normalize(vec3f(
    in.nrm.x - ds.y * in.nrm.y, in.nrm.y + ds.y * in.nrm.x, in.nrm.z));

  let R = shipMat(in.inst_att.x, in.inst_att.y, in.inst_loc.w);
  let p = R * (lp * in.inst_loc.z);
  let n = R * ln;

  let wx = in.inst_loc.x + p.x;
  let wy = in.inst_loc.y + p.y;
  let wz = p.z; // + toward viewer

  var clip = u.viewProj * vec4f(wx, wy, wz, 1.0);

  // Keep the near/far guard the hardcoded transform had.

  clip.z = clamp(clip.z, 0.0, clip.w);

  var out: VSOut;
  out.position = clip;
  out.normal = n;
  out.color = in.inst_col;
  out.baseCol = in.col;
  out.localPos = in.pos;
  return out;
}

// 3D hash & procedural noise functions for procedural chitin/bone textures
fn hash3(p: vec3f) -> vec3f {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}

fn noise3D(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);

  let n000 = dot(hash3(i + vec3f(0.0, 0.0, 0.0)) - 0.5, f - vec3f(0.0, 0.0, 0.0));
  let n100 = dot(hash3(i + vec3f(1.0, 0.0, 0.0)) - 0.5, f - vec3f(1.0, 0.0, 0.0));
  let n010 = dot(hash3(i + vec3f(0.0, 1.0, 0.0)) - 0.5, f - vec3f(0.0, 1.0, 0.0));
  let n110 = dot(hash3(i + vec3f(1.0, 1.0, 0.0)) - 0.5, f - vec3f(1.0, 1.0, 0.0));
  let n001 = dot(hash3(i + vec3f(0.0, 0.0, 1.0)) - 0.5, f - vec3f(0.0, 0.0, 1.0));
  let n101 = dot(hash3(i + vec3f(1.0, 0.0, 1.0)) - 0.5, f - vec3f(1.0, 0.0, 1.0));
  let n011 = dot(hash3(i + vec3f(0.0, 1.0, 1.0)) - 0.5, f - vec3f(0.0, 1.0, 1.0));
  let n111 = dot(hash3(i + vec3f(1.0, 1.0, 1.0)) - 0.5, f - vec3f(1.0, 1.0, 1.0));

  let lx0 = mix(n000, n100, u.x);
  let lx1 = mix(n001, n101, u.x);
  let ly0 = mix(n010, n110, u.x);
  let ly1 = mix(n011, n111, u.x);

  return mix(mix(lx0, ly0, u.y), mix(lx1, ly1, u.y), u.z) * 2.0;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let N = normalize(in.normal);
  let L = normalize(vec3f(-0.4, -0.55, 0.75)); // same key light as rock.wgsl
  let V = vec3f(0.0, 0.0, 1.0);

  // Team tint: near-white multiply (k = 0.55), the same read the sprite
  // hulls had — carapace keeps its bone/void palette, team hue soaks in.
  let k = 0.55;
  let tint = (1.0 - k) + k * in.color.rgb;

  // Emissive parts (baked colour components > 1) skip the lambert term and
  // breathe slowly with procedural bio-luminescent pulse waves.
  let emissive = max(max(in.baseCol.r, in.baseCol.g), in.baseCol.b) > 1.0;
  if (emissive) {
    let n = noise3D(in.localPos * 10.0 + vec3f(0.0, u.time * 2.5, 0.0));
    let pulse = 0.82 + 0.18 * sin(u.time * 2.6 + in.localPos.y * 3.0) + 0.1 * n;
    return vec4f(in.baseCol * tint * pulse, in.color.a);
  }

  // 1. Procedural 3D organic bio-chitin texture (multi-scale smooth noise)
  let n1 = noise3D(in.localPos * 16.0);
  let n2 = noise3D(in.localPos * 36.0 + vec3f(1.7, 3.1, 0.5)) * 0.5;
  let bioGrain = 1.0 + (n1 + n2) * 0.07;

  // 2. Cavity depth ambient occlusion (subtle darkening in lower recesses)
  let cavityAO = clamp(0.8 + 0.25 * (in.localPos.z + 0.2), 0.75, 1.05);

  // 3. Shading terms
  let diff = max(dot(N, L), 0.0);
  let amb = 0.22;
  let R_refl = reflect(-L, N);
  let spec = pow(max(dot(R_refl, V), 0.0), 16.0) * 0.35;
  let rim = pow(1.0 - max(N.z, 0.0), 3.0) * 0.25;

  // 4. Iridescent shell / pearlescent thin-film specular sheen
  let fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  let iridColor = 0.5 + 0.5 * cos(vec3f(0.0, 2.0, 4.0) + dot(N, V) * 6.28 + u.time * 0.3);
  let iridSpecular = spec * (vec3f(1.0) + iridColor * 0.7 * fresnel);

  let texturedBase = in.baseCol * bioGrain * cavityAO;
  let shade = texturedBase * tint * (amb + diff * 0.95) + vec3f(rim) + iridSpecular;
  return vec4f(shade, in.color.a);
}
