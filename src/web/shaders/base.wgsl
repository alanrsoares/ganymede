// Team base: a metallic sci-fi platform (n-gon drum) in gunmetal, with an
// emissive team-coloured trim strip and running lights that chase around the
// rim. Same vertex path + instance layout as the rock pass, so it plugs into the
// ROCK_LAYOUT mesh pass unchanged. The look is deliberately the opposite of the
// asteroids: clean brushed panels, hard metal spec, and glowing edge trim — a
// built installation, not a lump of stone. color.a carries damage (0 healthy →
// 1 wrecked): a hurt base's lights flicker and bleed red. The instance colour is
// already hp-dimmed on the CPU side.

struct Uniforms {
    resolution: vec2f,
    time: f32,
    depthScale: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
    @location(0) inst_loc: vec4f,  // [cx, cy, radius(px), _]
    @location(1) inst_rot: vec4f,  // [rx, ry, rz, _] tumble angles
    @location(2) inst_col: vec4f,  // [r, g, b, damage]
    @location(6) pos: vec3f,       // mesh vertex (fixed loc, see mesh-pass.ts)
    @location(7) nrm: vec3f,       // flat face normal
}

struct VSOut {
    @builtin(position) position: vec4f,
    @location(0) normal: vec3f,
    @location(1) color: vec4f,
    @location(2) localPos: vec3f,
}

// Compose Rz * Ry * Rx from a vector of angles.
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
    let trim = in.color.rgb;                    // team tint (hp-dimmed on CPU)
    let damage = clamp(in.color.a, 0.0, 1.0);   // 0 healthy → 1 wrecked

    // Gunmetal body: dark neutral steel so the team colour lives only in the
    // trim. Diffuse + a hard narrow spec reads as brushed metal.
    let body = vec3f(0.16, 0.18, 0.22);
    let diff = max(dot(N, L), 0.0);
    let spec = pow(max(dot(reflect(-L, N), V), 0.0), 40.0) * 0.7;
    let fres = pow(1.0 - max(N.z, 0.0), 3.0);
    let metal = body * (0.25 + 0.8 * diff) + vec3f(spec) + body * fres * 1.5;

    // Trim + running lights live on the outer edge (side wall + cap rim), found
    // from the unrotated local radius. `ang` gives a stable position around the
    // drum for the chasing light segments.
    let radial = length(in.localPos.xy);
    let edge = smoothstep(0.72, 0.99, radial);
    let ang = atan2(in.localPos.y, in.localPos.x);

    // Chasing running lights: sharp bright dashes travelling around the rim, plus
    // a steady dim trim glow underneath them.
    let chase = pow(0.5 + 0.5 * sin(ang * 8.0 - u.time * 3.0), 6.0);
    let trimGlow = edge * (0.35 + 1.4 * chase);

    // Steady when healthy; a wrecked base sputters.
    let flickAmp = 0.7 * damage;
    let flicker = (1.0 - flickAmp) + flickAmp * sin(u.time * 22.0 + ang * 4.0);

    let hot = mix(trim, vec3f(1.0), 0.5);
    let warn = vec3f(1.0, 0.2, 0.08) * damage * edge * chase * 1.2;

    let rgb = metal + hot * trimGlow * flicker + warn;
    return vec4f(rgb, 1.0);
}
