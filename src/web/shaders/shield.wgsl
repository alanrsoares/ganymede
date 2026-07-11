// Electric plasma shield bubble. A smooth sphere placed orthographically at the
// ship's screen position (shares the rock pass's frame uniforms). The surface is
// shaded procedurally: drifting 3D turbulence + ridged-noise "arcs" that crackle
// and flicker like electricity, wrapped in a fresnel rim. Drawn additively so it
// reads as glowing energy rather than a solid shell. The interpolated normal is
// the unit sphere point, so it doubles as a stable 3D coordinate for the noise.

struct Uniforms {
    resolution: vec2f,
    time: f32,
    depthScale: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
    @location(0) inst_loc: vec4f,  // [cx, cy, radius(px), strength 0..1]
    @location(1) inst_col: vec4f,  // [r, g, b, flash 0..1]
    @location(6) pos: vec3f,       // mesh vertex (fixed loc, see mesh-pass.ts)
    @location(7) nrm: vec3f,       // smooth normal (= vertex dir)
}

struct VSOut {
    @builtin(position) position: vec4f,
    @location(0) normal: vec3f,
    @location(1) color: vec4f,     // rgb + strength in .a
    @location(2) flash: f32,       // impact flare 0..1
}

@vertex
fn vs(in: VSIn) -> VSOut {
    let flash = in.inst_col.a;
    // A hit pops the bubble outward briefly.
    let radius = in.inst_loc.z * (1.0 + flash * 0.12);
    let p = in.pos * radius;
    let wx = in.inst_loc.x + p.x;
    let wy = in.inst_loc.y + p.y;
    let wz = p.z;

    let ndcx = wx / u.resolution.x * 2.0 - 1.0;
    let ndcy = -(wy / u.resolution.y * 2.0 - 1.0);
    let z = clamp(0.5 - wz * u.depthScale, 0.0, 1.0);

    var out: VSOut;
    out.position = vec4f(ndcx, ndcy, z, 1.0);
    out.normal = in.nrm;
    out.color = vec4f(in.inst_col.rgb, in.inst_loc.w);
    out.flash = flash;
    return out;
}

// --- cheap 3D value noise + fbm (hash from Dave Hoskins' hash13) ---
fn hash13(p3in: vec3f) -> f32 {
    var p3 = fract(p3in * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}

fn noise3(x: vec3f) -> f32 {
    let i = floor(x);
    let f = fract(x);
    let u2 = f * f * (3.0 - 2.0 * f);
    let n000 = hash13(i + vec3f(0.0, 0.0, 0.0));
    let n100 = hash13(i + vec3f(1.0, 0.0, 0.0));
    let n010 = hash13(i + vec3f(0.0, 1.0, 0.0));
    let n110 = hash13(i + vec3f(1.0, 1.0, 0.0));
    let n001 = hash13(i + vec3f(0.0, 0.0, 1.0));
    let n101 = hash13(i + vec3f(1.0, 0.0, 1.0));
    let n011 = hash13(i + vec3f(0.0, 1.0, 1.0));
    let n111 = hash13(i + vec3f(1.0, 1.0, 1.0));
    let nx00 = mix(n000, n100, u2.x);
    let nx10 = mix(n010, n110, u2.x);
    let nx01 = mix(n001, n101, u2.x);
    let nx11 = mix(n011, n111, u2.x);
    return mix(mix(nx00, nx10, u2.y), mix(nx01, nx11, u2.y), u2.z);
}

fn fbm(p: vec3f) -> f32 {
    var v = 0.0;
    var a = 0.5;
    var q = p;
    for (var i = 0; i < 4; i++) {
        v += a * noise3(q);
        q *= 2.0;
        a *= 0.5;
    }
    return v;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let N = normalize(in.normal);
    let t = u.time;
    let strength = in.color.a;

    // Drifting turbulence over the sphere surface.
    let coord = N * 3.5;
    let turb = fbm(coord + vec3f(0.0, t * 0.6, t * 0.3));

    // Ridged noise → thin filaments that wander: the electric arcs. High power
    // keeps them sparse and wispy rather than a solid bright shell.
    let ridged = fbm(coord * 1.9 + vec3f(t * 0.9, -t * 0.5, turb * 1.6));
    let arc = pow(1.0 - abs(ridged * 2.0 - 1.0), 9.0);
    // Flicker only when stressed: a full shield holds steady (flickAmp 0 → no
    // blink), a depleting one crackles harder as strength drops.
    let flickAmp = 0.5 * (1.0 - strength);
    let flicker = (1.0 - flickAmp) + flickAmp * sin(t * 22.0 + turb * 6.28);

    // Fresnel rim: faint at the silhouette, clear through the middle.
    let fres = pow(1.0 - max(N.z, 0.0), 2.2);

    // Impact flare: a hit briefly floods the whole bubble bright + hot, with a
    // ring rippling outward from the surface center to the rim.
    let flash = in.flash;
    let ripple = pow(1.0 - abs((1.0 - N.z) - (1.0 - flash)), 8.0) * flash;

    // Cyan/blue body; arcs only lightly tinted toward white so they don't blow out.
    let base = in.color.rgb;
    let arcCol = mix(base, vec3f(1.0), 0.4);
    let flareCol = mix(base, vec3f(1.0), 0.6);
    let rgb =
        base * (fres * 0.5 + 0.05) +
        arcCol * arc * flicker * 0.6 +
        base * fres * fres * 0.18 +
        flareCol * (flash * (fres * 0.6 + 0.12) + ripple * 0.7);

    // Dim + translucent: rim + crackle drive a low alpha, faint everywhere else.
    let a =
        strength *
        clamp(
            fres * 0.38 + arc * flicker * 0.45 + 0.02 +
                flash * 0.35 + ripple * 0.5,
            0.0,
            1.0,
        ) *
        0.6;
    return vec4f(rgb, a);
}
