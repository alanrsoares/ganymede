// Calm deep-space backdrop: a dark vertical gradient, a drifting nebula haze,
// and a couple of parallax star layers. Self-contained — reads only the frame
// uniforms (resolution + time), no simulation buffers.

struct Uniforms {
    resolution: vec2f,
    time: f32,
    _pad: f32}
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // Fullscreen triangle.
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  let uv = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, uv.x), mix(c, d, uv.x), uv.y);
}

// One twinkling star layer at a given grid density + drift.
fn starLayer(uv: vec2f, density: f32, drift: f32, tw: f32) -> f32 {
  let g = uv * density + vec2f(drift, drift * 0.3);
  let cell = floor(g);
  let f = fract(g);
  let rnd = hash21(cell);
  // Only the brightest cells hold a star; place it at a per-cell offset.
  if (rnd > 0.92) {
    let pos = vec2f(hash21(cell + 3.7), hash21(cell + 8.1));
    let d = length(f - pos);
    let star = smoothstep(0.08, 0.0, d);
    let flicker = 0.6 + 0.4 * sin(tw + rnd * 40.0);
    return star * flicker;
  }
  return 0.0;
}

@fragment
fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / u.resolution;
  let aspect = u.resolution.x / u.resolution.y;
  let auv = vec2f(uv.x * aspect, uv.y);

  // Base gradient: deep blue-black, a touch lighter toward the bottom.
  var col = mix(vec3f(0.015, 0.02, 0.04), vec3f(0.03, 0.05, 0.09), uv.y);

  // Drifting nebula haze — two octaves of value noise, tinted.
  let t = u.time * 0.02;
  let n = valueNoise(auv * 3.0 + vec2f(t, t * 0.5)) * 0.6
        + valueNoise(auv * 7.0 - vec2f(t * 0.7, t)) * 0.4;
  let nebula = smoothstep(0.55, 1.0, n);
  col += nebula * vec3f(0.08, 0.03, 0.14) * 0.6;

  // Parallax star layers (far = dim/slow, near = bright/fast).
  var stars = 0.0;
  stars += starLayer(auv, 60.0, u.time * 0.006, u.time * 2.0) * 0.5;
  stars += starLayer(auv, 30.0, u.time * 0.012, u.time * 3.0) * 0.8;
  stars += starLayer(auv, 16.0, u.time * 0.02, u.time * 4.0);
  col += vec3f(stars) * vec3f(0.9, 0.95, 1.0);

  // Vignette to focus the play area.
  let vig = 1.0 - 0.5 * pow(length(uv - 0.5) * 1.3, 2.2);
  col *= clamp(vig, 0.4, 1.0);

  return vec4f(col, 1.0);
}
