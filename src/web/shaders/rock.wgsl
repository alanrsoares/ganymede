// 3D asteroid mesh pass. Rocks are instanced lumps positioned in screen pixels
// (orthographic, so they stay pinned to their 2D grid spot) but carry real depth
// and lit normals. Shares the frame uniform layout with the sprite/bg passes:
// resolution in .xy, time in .z, and a depth-compression scale in .w.

struct Uniforms {
    resolution: vec2f,
    time: f32,
    depthScale: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
    @location(0) inst_loc: vec4f,  // [cx, cy, radius(px), _]
    @location(1) inst_rot: vec4f,  // [rx, ry, rz, _] tumble angles
    @location(2) inst_col: vec4f,  // rock base color
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
    let p = R * (in.pos * in.inst_loc.z);   // scale to pixel radius, then tumble
    let n = R * in.nrm;

    let wx = in.inst_loc.x + p.x;
    let wy = in.inst_loc.y + p.y;
    let wz = p.z;                            // + toward viewer

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

// --- cheap 3D value noise (hash from Dave Hoskins' hash13) ---
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

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let N = normalize(in.normal);
    let L = normalize(vec3f(-0.4, -0.55, 0.75));  // key light, upper-left, toward us
    let V = vec3f(0.0, 0.0, 1.0);                 // view direction (orthographic)
    
    // Base lighting
    let diff = max(dot(N, L), 0.0);
    let amb = 0.22;
    
    // Specular highlight to give a metallic/ore gleam
    let R_refl = reflect(-L, N);
    let spec = pow(max(dot(R_refl, V), 0.0), 16.0) * 0.35;
    
    // Cheap rim to lift silhouettes off the starfield
    let rim = pow(1.0 - max(N.z, 0.0), 3.0) * 0.25;
    
    // Add fine-grained rock texture using noise
    let rockNoise = noise3(in.localPos * 8.0);
    let baseCol = in.color.rgb * (0.85 + 0.15 * rockNoise);
    
    // Glowing veins based on damage parameter.
    let damage = clamp(in.color.a, 0.0, 1.0);
    
    // Thin crack lines on the surface
    let crackNoise = noise3(in.localPos * 4.2);
    let crackPattern = pow(1.0 - abs(crackNoise * 2.0 - 1.0), 8.0); // sharp ridged valleys
    
    // Pulse animation for the glowing energy core
    let pulse = 0.75 + 0.25 * sin(u.time * 6.5 + crackNoise * 10.0);
    let glowColor = vec3f(1.0, 0.28, 0.04) * crackPattern * damage * 1.8 * pulse;
    
    // Combine shading: diffuse + specular + rim + glowing cracks
    let shade = baseCol * (amb + diff * 0.95) + vec3f(rim) + vec3f(spec) + glowColor;
    
    return vec4f(shade, 1.0);
}
