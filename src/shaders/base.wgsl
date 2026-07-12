// Base / center-pad core: a faceted 100-face orb, flat-shaded so each face reads
// as a distinct facet, carrying a per-vertex iridescent colour. That vertex
// colour is washed by the instance tint (team hue for a base, resource-phase hue
// for the center pad) so the orb stays identifiable while its facets shimmer.
// Same instance layout as the rock pass (ROCK_LAYOUT). color.a carries damage
// (0 healthy → 1 wrecked): a hurt base flickers and bleeds red. The instance
// colour is already hp-dimmed on the CPU side.

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
    @location(8) vcol: vec3f,      // per-vertex iridescent colour
}

struct VSOut {
    @builtin(position) position: vec4f,
    @location(0) normal: vec3f,
    @location(1) color: vec4f,
    @location(2) localPos: vec3f,
    @location(3) vcol: vec3f,
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
    out.vcol = in.vcol;
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let N = normalize(in.normal);
    let L = normalize(vec3f(-0.4, -0.55, 0.75));
    let V = vec3f(0.0, 0.0, 1.0);
    let tint = in.color.rgb;                    // team / phase hue (hp-dimmed)
    let damage = clamp(in.color.a, 0.0, 1.0);   // 0 healthy → 1 wrecked

    // Facet colour: the team/phase tint washed halfway with the vertex
    // iridescence, so the orb keeps its identity but every facet reads distinctly.
    let facet = tint * mix(vec3f(1.0), in.vcol, 0.5);

    // Faceted lighting: flat per-face normal → hard shading steps between facets.
    let diff = max(dot(N, L), 0.0);
    let spec = pow(max(dot(reflect(-L, N), V), 0.0), 24.0) * 0.6;
    let fres = pow(1.0 - max(N.z, 0.0), 2.5);   // rim catches the light

    var rgb = facet * (0.35 + 0.85 * diff) + vec3f(spec) + tint * fres * 0.8;

    // Damage: a wrecked core flickers and bleeds red-hot.
    let flick = 0.55 + 0.45 * sin(u.time * 18.0 + in.localPos.y * 6.0);
    rgb = mix(rgb, vec3f(1.0, 0.22, 0.08) * flick, damage * 0.7);

    return vec4f(rgb, 1.0);
}
