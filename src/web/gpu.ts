// WebGPU renderer: draws the GoL engine's current generation as the
// background, plus instanced sprites (circuit nodes, connections, pulses).

import type { GolEngine } from "./gol-gpu";
import type { GpuContext } from "./gpu-context";

const backgroundWGSL = /* wgsl */ `
struct Uniforms { resolution: vec2f, time: f32, _pad: f32 }
struct Grid { w: u32, h: u32 }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<uniform> grid: Grid;
@group(0) @binding(2) var<storage, read> cells: array<u32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(pos[vi], 0, 1);
}

@fragment
fn fs(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let uv = fragPos.xy / u.resolution;
  let cx = min(u32(uv.x * f32(grid.w)), grid.w - 1u);
  let cy = min(u32(uv.y * f32(grid.h)), grid.h - 1u);
  let alive = f32(cells[cy * grid.w + cx]);
  let base = vec3f(0.016, 0.027, 0.039);
  let cell = vec3f(0.07, 0.22, 0.17);
  return vec4f(base + cell * alive, 1.0);
}
`;

const spritesWGSL = /* wgsl */ `
struct Uniforms { resolution: vec2f, time: f32, _pad: f32 }
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
  @builtin(vertex_index) vi: u32,
  @location(0) posSize: vec4f,  // center.xy (px), halfSize.xy (px)
  @location(1) rotShape: vec4f, // rotation, shape (0 rect | 1 circle), unused x2
  @location(2) color: vec4f,
}
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec4f,
  @location(2) shape: f32,
}

@vertex
fn vs(in: VSIn) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
    vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1),
  );
  let c = corners[in.vi];
  let r = in.rotShape.x;
  let rot = mat2x2f(cos(r), sin(r), -sin(r), cos(r));
  let world = in.posSize.xy + rot * (c * in.posSize.zw);
  let ndc = vec2f(
    world.x / u.resolution.x * 2.0 - 1.0,
    1.0 - world.y / u.resolution.y * 2.0,
  );
  var out: VSOut;
  out.pos = vec4f(ndc, 0, 1);
  out.local = c;
  out.color = in.color;
  out.shape = in.rotShape.y;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  var alpha = in.color.a;
  if (in.shape > 0.5) {
    let d = length(in.local);
    if (d > 1.0) { discard; }
    alpha *= 1.0 - smoothstep(0.7, 1.0, d);
  }
  return vec4f(in.color.rgb, alpha);
}
`;

export const FLOATS_PER_INSTANCE = 12; // posSize(4) + rotShape(4) + color(4)
const MAX_INSTANCES = 256;

export interface Renderer {
  render(
    instances: Float32Array<ArrayBuffer>,
    instanceCount: number,
    time: number,
  ): void;
  resize(): void;
}

export const createRenderer = (
  { device, context, format }: GpuContext,
  canvas: HTMLCanvasElement,
  engine: GolEngine,
): Renderer => {
  // Shared frame uniforms: resolution + time
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // --- Background pipeline (reads the GoL engine's cell buffers) ---
  const bgModule = device.createShaderModule({ code: backgroundWGSL });
  const bgPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: bgModule, entryPoint: "vs" },
    fragment: { module: bgModule, entryPoint: "fs", targets: [{ format }] },
  });
  const bgBindGroups = [0, 1].map((i) =>
    device.createBindGroup({
      layout: bgPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: engine.gridBuffer } },
        { binding: 2, resource: { buffer: engine.cellBuffers[i] } },
      ],
    }),
  );

  // --- Sprite pipeline ---
  const instanceBuffer = device.createBuffer({
    size: MAX_INSTANCES * FLOATS_PER_INSTANCE * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const spriteModule = device.createShaderModule({ code: spritesWGSL });
  const spritePipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: spriteModule,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: FLOATS_PER_INSTANCE * 4,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
            { shaderLocation: 2, offset: 32, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module: spriteModule,
      entryPoint: "fs",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
            },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
  });
  const spriteBindGroup = device.createBindGroup({
    layout: spritePipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  };
  resize();

  return {
    resize,
    render: (instances, instanceCount, time) => {
      device.queue.writeBuffer(
        uniformBuffer,
        0,
        new Float32Array([canvas.width, canvas.height, time, 0]),
      );
      device.queue.writeBuffer(
        instanceBuffer,
        0,
        instances,
        0,
        instanceCount * FLOATS_PER_INSTANCE,
      );

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: "clear",
            clearValue: { r: 0.016, g: 0.027, b: 0.039, a: 1 },
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(bgPipeline);
      pass.setBindGroup(0, bgBindGroups[engine.currentIndex()]);
      pass.draw(3);

      if (instanceCount > 0) {
        pass.setPipeline(spritePipeline);
        pass.setBindGroup(0, spriteBindGroup);
        pass.setVertexBuffer(0, instanceBuffer);
        pass.draw(6, instanceCount);
      }
      pass.end();

      device.queue.submit([encoder.finish()]);
    },
  };
};
