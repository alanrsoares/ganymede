// Bloom post-process. The scene is rendered to an offscreen texture, then:
//   bright-pass → blur H → blur V → composite (scene + blurred brights, additive)
// Every stage is a fullscreen triangle. Blur runs at half-res (cheap + wider).

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
    // Oversized triangle covering the viewport.
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    let xy = p[i];
    var out: VSOut;
    out.pos = vec4f(xy, 0.0, 1.0);
    out.uv = vec2f((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
    return out;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex0: texture_2d<f32>;
@group(0) @binding(2) var tex1: texture_2d<f32>;

fn luma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// Keep only the bright energy (bolts, plasma, explosions) — the neon that glows.
@fragment
fn fs_bright(in: VSOut) -> @location(0) vec4f {
    let c = textureSample(tex0, samp, in.uv).rgb;
    let l = luma(c);
    let t = 0.62; // threshold
    let k = max(0.0, l - t) / max(l, 1e-4);
    return vec4f(c * k, 1.0);
}

// 9-tap gaussian along `dir`, texel size from the source dimensions.
fn blur(uv: vec2f, dir: vec2f) -> vec3f {
    let dims = vec2f(textureDimensions(tex0));
    let texel = dir / dims;
    let w = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
    var sum = textureSample(tex0, samp, uv).rgb * w[0];
    for (var i = 1; i < 5; i++) {
        let o = texel * f32(i);
        sum += textureSample(tex0, samp, uv + o).rgb * w[i];
        sum += textureSample(tex0, samp, uv - o).rgb * w[i];
    }
    return sum;
}

@fragment
fn fs_blur_h(in: VSOut) -> @location(0) vec4f {
    return vec4f(blur(in.uv, vec2f(1.0, 0.0)), 1.0);
}

@fragment
fn fs_blur_v(in: VSOut) -> @location(0) vec4f {
    return vec4f(blur(in.uv, vec2f(0.0, 1.0)), 1.0);
}

// Scene (tex0) + blurred brights (tex1), additive with a soft strength.
@fragment
fn fs_composite(in: VSOut) -> @location(0) vec4f {
    let scene = textureSample(tex0, samp, in.uv).rgb;
    let bloom = textureSample(tex1, samp, in.uv).rgb;
    return vec4f(scene + bloom * 1.15, 1.0);
}
