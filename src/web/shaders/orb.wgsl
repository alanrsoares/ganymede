// Power-up orb: a solid, glossy 3D energy sphere. Unlike the translucent shield,
// this is lit (diffuse + a sharp specular hotspot), glows from within (emissive
// toward the viewer), and has a fresnel rim — so it reads as a physical orb the
// bloom pass then makes bloom. Shares the frame uniforms + mesh layout.

struct Uniforms {
    resolution: vec2f,
    time: f32,
    depthScale: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
    @location(0) inst_loc: vec4f, // [cx, cy, radius(px), _]
    @location(1) inst_col: vec4f, // [r, g, b, _]
    @location(6) pos: vec3f,
    @location(7) nrm: vec3f,
}

struct VSOut {
    @builtin(position) position: vec4f,
    @location(0) normal: vec3f,
    @location(1) color: vec4f,
}

@vertex
fn vs(in: VSIn) -> VSOut {
    let p = in.pos * in.inst_loc.z;
    let wx = in.inst_loc.x + p.x;
    let wy = in.inst_loc.y + p.y;
    let wz = p.z;
    let ndcx = wx / u.resolution.x * 2.0 - 1.0;
    let ndcy = -(wy / u.resolution.y * 2.0 - 1.0);
    let z = clamp(0.5 - wz * u.depthScale, 0.0, 1.0);

    var out: VSOut;
    out.position = vec4f(ndcx, ndcy, z, 1.0);
    out.normal = in.nrm;
    out.color = vec4f(in.inst_col.rgb, 1.0);
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let N = normalize(in.normal);
    let L = normalize(vec3f(-0.4, -0.55, 0.75)); // key light, upper-left
    let V = vec3f(0.0, 0.0, 1.0);                 // ortho view dir
    let base = in.color.rgb;

    let diff = max(dot(N, L), 0.0);
    let spec = pow(max(dot(reflect(-L, N), V), 0.0), 32.0) * 0.9; // glossy hotspot
    let fres = pow(1.0 - max(N.z, 0.0), 3.0) * 0.7;               // rim
    let core = pow(max(N.z, 0.0), 1.5) * 0.55;                    // inner glow
    // Faint animated shimmer so the surface feels alive.
    let shimmer = 0.04 * sin(N.x * 9.0 + N.y * 7.0 + u.time * 4.0);

    let rgb =
        base * (0.28 + 0.72 * diff + core + shimmer) +
        base * fres +
        vec3f(spec);
    return vec4f(rgb, 0.96);
}
