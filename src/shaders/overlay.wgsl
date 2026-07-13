struct Uniforms {
    resolution: vec2f,
    time: f32,
    _pad: f32}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var t_array: texture_2d_array<f32>;
@group(0) @binding(2) var s_sampler: sampler;

// Highest valid sprite-atlas layer index. Injected at pipeline creation from
// SPRITE_LAYER_COUNT - 1 (see gpu.ts `constants`); the default keeps this file
// valid WGSL on its own.
override LAYER_MAX: f32 = 0.0;

struct VSIn {
    @builtin(vertex_index) vi: u32,
    @location(0) posSize: vec4f,   // [cx, cy, hx, hy] in window pixels
    @location(1) rotShape: vec4f,  // [rot, shape, layer, _]
    @location(2) color: vec4f,
}

struct VSOut {
    @builtin(position) position: vec4f,
    @location(0) local: vec2f,     // [-1..1, -1..1]
    @location(1) color: vec4f,
    @location(2) shape: f32,
    @location(3) layer: f32,
}

@vertex
fn vs(in: VSIn) -> VSOut {
    var corners = array<vec2f, 6>(
        vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
        vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1)
    );
    let local = corners[in.vi];

    let scale = in.posSize.zw * 1.1;
    let angle = in.rotShape.x;
    let rot = mat2x2f(cos(angle), -sin(angle), sin(angle), cos(angle));
    let rotated = rot * (local * scale);

    let world = in.posSize.xy + rotated;
    let clip = (world / u.resolution) * 2.0 - 1.0;

    var out: VSOut;
    out.position = vec4f(clip.x, -clip.y, 0.0, 1.0);
    out.local = local;
    out.color = in.color;
    out.shape = in.rotShape.y;
    out.layer = in.rotShape.z;
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    var alpha = in.color.a;
    let d = length(in.local);

    // Sample the sprite atlas in uniform control flow. WGSL forbids textureSample
    // inside branches that depend on a non-uniform value (in.shape), so hoist it
    // here; only the sprite branch below actually consumes the result.
    let tex_coord = vec2f((in.local.x + 1.0) / 2.0, (1.0 - in.local.y) / 2.0);
    let layer_idx = u32(clamp(round(in.layer), 0.0, LAYER_MAX));
    let texColor = textureSample(t_array, s_sampler, tex_coord, layer_idx);

    if in.shape > 9.5 {
        // Sprite silhouette: alpha mask from texture, color purely from instance tint
        if texColor.a < 0.15 { discard; }
        return vec4f(in.color.rgb * 1.25, texColor.a * in.color.a);
    } else if in.shape > 8.5 {
        // Spiraling accretion vortex (portals). A dark event horizon in the
        // middle, logarithmic-spiral arms winding into it and heating to white,
        // fading out inside the circular contour. in.layer carries the spin sign
        // so a linked gate pair counter-rotates; the whole disc turns with time.
        if d > 1.0 { discard; }
        let spin = select(-1.0, 1.0, in.layer >= 0.0);
        let theta = atan2(in.local.y, in.local.x);
        let t = u.time * 1.2 * spin;
        // Constant phase along log-radius curves ⇒ true logarithmic spiral arms.
        let swirl = sin(3.0 * theta + 6.0 * log(d + 0.05) - t);
        let arms = smoothstep(0.25, 1.0, swirl);
        let hole = smoothstep(0.0, 0.55, d);          // 0 in the horizon → 1 mid
        let rim = 1.0 - smoothstep(0.82, 1.0, d);     // fade inside the contour
        let heat = 1.0 - smoothstep(0.15, 0.7, d);    // white-hot near the horizon
        let base = mix(vec3f(0.02, 0.02, 0.06), in.color.rgb * 0.5, hole);
        let armCol = mix(in.color.rgb, vec3f(1.0), heat);
        let rgb = base + armCol * arms * (0.3 + 0.7 * hole);
        let a = rim * in.color.a;
        if a < 0.02 { discard; }
        return vec4f(rgb, clamp(a, 0.0, 1.0));
    } else if in.shape > 7.5 {
        // Plasma bolt: an elongated energy streak. The quad is scaled thin +
        // long and rotated to the bullet's heading, so local.x is the width and
        // local.y runs along travel. A hot white spine down the center melts
        // into a team-colored glow across the width, and both tips taper so the
        // bolt reads as a lozenge of light rather than a hard rod.
        let ax = abs(in.local.x);          // across the width
        let ay = abs(in.local.y);          // along the length
        let glow = 1.0 - smoothstep(0.0, 1.0, ax);      // soft team halo
        let core = 1.0 - smoothstep(0.0, 0.42, ax);     // tight bright spine
        let taper = 1.0 - smoothstep(0.5, 1.0, ay);     // round off both tips
        let body = glow * taper;
        if body < 0.02 { discard; }
        let hot = pow(core * taper, 1.5);               // white-hot near center
        let rgb = mix(in.color.rgb * 1.4, vec3f(1.0), hot);
        return vec4f(rgb, clamp(body, 0.0, 1.0) * in.color.a);
    } else if in.shape > 6.5 {
        // Neon soundwave pad: concentric rings whose radius ripples like an
        // oscilloscope trace. in.layer carries a per-pad collision drift [0..1].
        let theta = atan2(in.local.y, in.local.x);
        let t = u.time;
        let drift = in.layer;
        let wave = (0.038 + 0.035 * drift) * sin(theta * 6.0 + t * 1.8)
             + 0.020 * sin(theta * 11.0 - t * 1.2)
             + 0.014 * sin(theta * 3.0 + t * 0.8 + drift * 6.28);
        var glow = 0.0;
        for (var i = 0; i < 3; i++) {
            let r = 0.42 + f32(i) * 0.22 + wave * (1.0 + f32(i) * 0.6);
            let dist = abs(d - r);
            let thickness = 0.05 + 0.025 * drift;
            // Wider, softer falloff for a gentler neon bloom.
            glow += (1.0 - smoothstep(0.0, thickness, dist)) * 0.8;
        }
        if glow < 0.02 { discard; }
        let neon = in.color.rgb * (1.2 + drift * 0.5);
        return vec4f(neon, clamp(glow, 0.0, 1.0) * in.color.a);
    } else if in.shape > 5.5 {
        // Laser Beam capsule: thin glowing vertical strip
        if abs(in.local.x) > 0.18 { discard; }
        alpha *= (1.0 - smoothstep(0.0, 0.18, abs(in.local.x))) * (1.0 - abs(in.local.y));
        return vec4f(in.color.rgb, alpha);
    } else if in.shape > 4.5 {
        // FX sprite (explosions, mine detonations): textured like a plain sprite,
        // but with a soft radial edge fade so a glow that reaches the frame border
        // dissolves instead of hard-cutting into a square.
        if texColor.a < 0.12 { discard; }
        let fade = 1.0 - smoothstep(0.82, 1.0, d);
        return vec4f(texColor.rgb * 1.35, texColor.a * in.color.a * fade);
    } else if in.shape > 3.5 {
        // Tinted sprite: texture multiplied by the instance color (team-colored
        // bases). Transparent pixels discard like the plain sprite branch.
        if texColor.a < 0.15 { discard; }
        return vec4f(texColor.rgb * in.color.rgb * 1.5, texColor.a * in.color.a);
    } else if in.shape > 2.5 {
        // SpaceRage Sprite texture sample! Transparent sprite pixels discard so no
        // colored disc bleeds out from behind the ship/explosion/exhaust art.
        if texColor.a < 0.15 { discard; }
        // Boost brightness slightly to make them glow with neon grid environment
        return vec4f(texColor.rgb * 1.35, texColor.a * in.color.a);
    } else if in.shape > 1.5 {
        // Hollow vector ring base: radius 0.8 to 1.0 (note sensor pad)
        if d > 1.0 || d < 0.8 { discard; }

        // Subdivide ring into 4 distinct brackets/ticks along the circumference
        let angle_local = atan2(in.local.y, in.local.x);
        let check = cos(angle_local * 4.0);
        if check < -0.3 {
            discard;
        }
        alpha *= smoothstep(0.8, 0.86, d) * (1.0 - smoothstep(0.94, 1.0, d));
        if check > 0.8 {
            alpha *= 1.35;
        }
    } else if in.shape > 0.5 {
        // Solid circle
        if d > 1.0 { discard; }
        alpha *= 1.0 - smoothstep(0.7, 1.0, d);
    }
    return vec4f(in.color.rgb, alpha);
}
