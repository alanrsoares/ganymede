// Center pad: the neutral prize. Shares the base's metallic-platform DNA (n-gon
// drum, emissive edge trim, running lights) but reads as gold rather than a team,
// and runs richer + steadier — no damage state, a brighter chasing trim, and a
// glowing gold emblem inlaid on the top face that breathes with the beacon. Same
// vertex path + instance layout as the rock pass. color.a is a 0..1 glow drive.

struct Uniforms {
    resolution: vec2f,
    time: f32,
    depthScale: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
    @location(0) inst_loc: vec4f,  // [cx, cy, radius(px), _]
    @location(1) inst_rot: vec4f,  // [rx, ry, rz, _] tumble angles
    @location(2) inst_col: vec4f,  // [r, g, b, glow]
    @location(6) pos: vec3f,       // mesh vertex (fixed loc, see mesh-pass.ts)
    @location(7) nrm: vec3f,       // flat face normal
}

struct VSOut {
    @builtin(position) position: vec4f,
    @location(0) normal: vec3f,
    @location(1) color: vec4f,
    @location(2) localPos: vec3f,
}

fn rotMat(a: vec3f) -> mat3x3f {
    let cx = cos(a.x); let sx = sin(a.x);
    let cy = cos(a.y); let sy = sin(a.y);
    let cz = cos(a.z); let sz = sin(a.z);
    let rx = mat3x3f(1, 0, 0, 0, cx, sx, 0, -sx, cx);
    let ry = mat3x3f(cy, 0, -sy, 0, 1, 0, sy, 0, cy);
    let rz = mat3x3f(cz, sz, 0, -sz, cz, 0, 0, 0, 1);
    return rz * ry * rx;
}

@vertex
fn vs(in: VSIn) -> VSOut {
    let R = rotMat(in.inst_rot.xyz);
    let p = R * (in.pos * in.inst_loc.z);
    let n = R * in.nrm;

    let wx = in.inst_loc.x + p.x;
    let wy = in.inst_loc.y + p.y;
    let wz = p.z;

    let ndcx = wx / u.resolution.x * 2.0 - 1.0;
    let ndcy = -(wy / u.resolution.y * 2.0 - 1.0);
    let z = clamp(0.5 - wz * u.depthScale, 0.0, 1.0);

    var out: VSOut;
    out.position = vec4f(ndcx, ndcy, z, 1.0);
    out.normal = n;
    out.color = in.inst_col;
    out.localPos = in.pos;
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let N = normalize(in.normal);
    let L = normalize(vec3f(-0.4, -0.55, 0.75));
    let V = vec3f(0.0, 0.0, 1.0);
    let gold = in.color.rgb;
    let glow = clamp(in.color.a, 0.0, 1.0);
    let pulse = 0.7 + 0.3 * sin(u.time * 3.0);

    // Warm bronze body so gold trim sits on a metal, not a flat fill.
    let body = vec3f(0.20, 0.16, 0.09);
    let diff = max(dot(N, L), 0.0);
    let spec = pow(max(dot(reflect(-L, N), V), 0.0), 44.0) * 0.9;
    let fres = pow(1.0 - max(N.z, 0.0), 3.0);
    let metal = body * (0.3 + 0.85 * diff) + vec3f(spec) + body * fres * 1.6;

    let radial = length(in.localPos.xy);
    let ang = atan2(in.localPos.y, in.localPos.x);

    // Edge trim + chasing running lights, brighter and faster than a team base.
    let edge = smoothstep(0.72, 0.99, radial);
    let chase = pow(0.5 + 0.5 * sin(ang * 10.0 - u.time * 4.0), 6.0);
    let trimGlow = edge * (0.5 + 1.8 * chase) * (0.7 + 0.6 * glow);

    // Top-face emblem: a glowing concentric gold ring inlaid on the cap, pulsing
    // with the beacon so the pad reads as "the prize" from directly above.
    let topFace = smoothstep(0.0, 0.05, in.localPos.z);
    let ring = pow(1.0 - abs(radial - 0.42) * 6.0, 4.0);
    let emblem = topFace * clamp(ring, 0.0, 1.0) * (0.6 + 0.9 * glow) * pulse;

    let hot = mix(gold, vec3f(1.0, 0.95, 0.8), 0.55);
    let rgb = metal + hot * trimGlow + hot * emblem * 1.4;
    return vec4f(rgb, 1.0);
}
