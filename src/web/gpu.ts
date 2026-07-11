// WebGPU renderer: draws a procedural starfield background plus the instanced
// game sprites (ships, asteroids, mines, pickups, explosions, HUD rings).

import * as d from "typegpu/data";
import type { GpuContext } from "./gpu-context";
import { makeAsteroidMesh, makeSphereMesh } from "./mesh";
import { createMeshPass, instanceLayout, type MeshPass } from "./mesh-pass";
// WGSL lives in .wgsl files (real syntax highlighting) and is imported as text.
import backgroundWGSL from "./shaders/background.wgsl" with { type: "text" };
import bloomWGSL from "./shaders/bloom.wgsl" with { type: "text" };
import orbWGSL from "./shaders/orb.wgsl" with { type: "text" };
import overlayWGSL from "./shaders/overlay.wgsl" with { type: "text" };
import rockWGSL from "./shaders/rock.wgsl" with { type: "text" };
import shieldWGSL from "./shaders/shield.wgsl" with { type: "text" };
import { SPRITE_LAYER_COUNT, SPRITE_URLS } from "./sprites";

// --- Sprite/Overlay pipeline (space shooter sprites and vector rings) ---

export const FLOATS_PER_INSTANCE = 12; // posSize(4) + rotShape(4) + color(4)
// Headroom for a busy fight: ~14 sprites/ace-ship × 12 ships + bolts + missiles
// + mines + shrapnel + bursts + field furniture. overlay.push warns if exceeded.
export const MAX_INSTANCES = 768;

// --- 3D mesh passes (rocks, shields). Each layout is the single source of truth
// for its float count, vertex attributes, and named packing offsets (see
// overlay.ts). WGSL @location structs must list fields in this same order. ---
export const MAX_ROCKS = 128;
export const MAX_SHIELDS = 16; // ship shields
export const MAX_ORBS = 12; // power-up energy orbs (own solid-lit pass)
// prettier-ignore
export const ROCK_LAYOUT = instanceLayout([
  "cx",
  "cy",
  "radius",
  "_a",
  "rx",
  "ry",
  "rz",
  "_b",
  "r",
  "g",
  "b",
  "_c",
]);
export const SHIELD_LAYOUT = instanceLayout([
  "cx",
  "cy",
  "radius",
  "strength",
  "r",
  "g",
  "b",
  "flash",
]);
const DEPTH_FORMAT = "depth24plus";
// Compresses pixel-space z into the [0,1] depth range (radius ≲ 60px stays well
// inside the band, so rocks self-occlude without ever clipping the near/far plane).
const DEPTH_SCALE = 0.0016;

// Typed data model for the per-frame uniforms and per-sprite instance layout.
// These schemas mirror the WGSL structs; TypeGPU derives sizes/strides so the
// magic byte math (16, FLOATS_PER_INSTANCE * 4) is expressed once, in types.
const FrameUniforms = d.struct({
  resolution: d.vec2f,
  time: d.f32,
  _pad: d.f32,
});
const Instance = d.struct({
  posSize: d.vec4f, // [cx, cy, hx, hy]
  rotShape: d.vec4f, // [rot, shape, layer, _]
  color: d.vec4f,
});
const InstanceArray = d.arrayOf(Instance, MAX_INSTANCES);

export interface Renderer {
  render(
    instances: Float32Array<ArrayBuffer>,
    instanceCount: number,
    rockInstances: Float32Array<ArrayBuffer>,
    rockCount: number,
    shieldInstances: Float32Array<ArrayBuffer>,
    shieldCount: number,
    orbInstances: Float32Array<ArrayBuffer>,
    orbCount: number,
    time: number,
  ): void;
  resize(): void;
}

interface BackgroundPipeline {
  bgPipeline: GPURenderPipeline;
  bgBindGroup: GPUBindGroup;
}

// --- Background pipeline (procedural starfield; frame uniforms only) ---
const createBackgroundPipeline = (
  device: GPUDevice,
  format: GPUTextureFormat,
  uniformBuffer: GPUBuffer,
): BackgroundPipeline => {
  const bgModule = device.createShaderModule({ code: backgroundWGSL });
  const bgPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: bgModule, entryPoint: "vs" },
    fragment: { module: bgModule, entryPoint: "fs", targets: [{ format }] },
    // The pass owns a depth buffer for the rocks; the background never tests or
    // writes it (drawn first, behind everything).
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: "always",
    },
  });
  const bgBindGroup = device.createBindGroup({
    layout: bgPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });
  return { bgPipeline, bgBindGroup };
};

interface SpritePipeline {
  instanceBuffer: GPUBuffer;
  spritePipeline: GPURenderPipeline;
  spriteBindGroup: GPUBindGroup;
}

// --- Sprite pipeline ---
const createSpritePipeline = (
  device: GPUDevice,
  format: GPUTextureFormat,
  root: GpuContext["root"],
  uniformBuffer: GPUBuffer,
  textureView: GPUTextureView,
  sampler: GPUSampler,
): SpritePipeline => {
  const instanceBuffer = root.unwrap(
    root.createBuffer(InstanceArray).$usage("vertex"),
  );
  const spriteModule = device.createShaderModule({ code: overlayWGSL });
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
      // Inject the atlas layer ceiling into the shader's LAYER_MAX override.
      constants: { LAYER_MAX: SPRITE_LAYER_COUNT - 1 },
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
    // Sprites draw over the rocks unconditionally (2D layering by draw order).
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: "always",
    },
  });
  const spriteBindGroup = device.createBindGroup({
    layout: spritePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: textureView },
      { binding: 2, resource: sampler },
    ],
  });
  return { instanceBuffer, spritePipeline, spriteBindGroup };
};

interface MeshPasses {
  rockPass: MeshPass;
  shieldPass: MeshPass;
  orbPass: MeshPass;
}

// --- 3D mesh passes: opaque tumbling rocks + additive translucent shields +
// solid-lit power-up orbs. All are adapters of createMeshPass; they differ
// only in mesh, layout, blend, and depth mode. ---
const createMeshPasses = (
  device: GPUDevice,
  format: GPUTextureFormat,
  uniformBuffer: GPUBuffer,
): MeshPasses => {
  const rockPass = createMeshPass(device, {
    format,
    uniformBuffer,
    mesh: makeAsteroidMesh(2),
    shader: rockWGSL,
    layout: ROCK_LAYOUT,
    maxInstances: MAX_ROCKS,
    depthFormat: DEPTH_FORMAT,
    depthWrite: true,
    depthCompare: "less",
  });
  const shieldPass = createMeshPass(device, {
    format,
    uniformBuffer,
    mesh: makeSphereMesh(3), // subdiv 3 → round rim, no facets
    shader: shieldWGSL,
    layout: SHIELD_LAYOUT,
    maxInstances: MAX_SHIELDS,
    // Additive glow so the plasma reads as emitted energy, not a solid shell.
    blend: {
      color: { srcFactor: "src-alpha", dstFactor: "one" },
      alpha: { srcFactor: "one", dstFactor: "one" },
    },
    depthFormat: DEPTH_FORMAT,
    depthWrite: false, // overlays ships; drawn last, ignores depth
    depthCompare: "always",
  });
  // Power-up orbs: solid glossy spheres (own lit shader), alpha-blended over the
  // field. Reuses the shield instance layout (cx,cy,radius + rgb).
  const orbPass = createMeshPass(device, {
    format,
    uniformBuffer,
    mesh: makeSphereMesh(2),
    shader: orbWGSL,
    layout: SHIELD_LAYOUT,
    maxInstances: MAX_ORBS,
    blend: {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
    },
    depthFormat: DEPTH_FORMAT,
    depthWrite: false,
    depthCompare: "always",
  });
  return { rockPass, shieldPass, orbPass };
};

interface BloomPipelines {
  postSampler: GPUSampler;
  brightPipeline: GPURenderPipeline;
  blurHPipeline: GPURenderPipeline;
  blurVPipeline: GPURenderPipeline;
  compositePipeline: GPURenderPipeline;
}

// --- Bloom post-process pipelines (fullscreen triangle, created once) ---
const createBloomPipelines = (
  device: GPUDevice,
  format: GPUTextureFormat,
): BloomPipelines => {
  const postSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const bloomModule = device.createShaderModule({ code: bloomWGSL });
  const postPipeline = (entryPoint: string) =>
    device.createRenderPipeline({
      layout: "auto",
      vertex: { module: bloomModule, entryPoint: "vs" },
      fragment: { module: bloomModule, entryPoint, targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  const brightPipeline = postPipeline("fs_bright");
  const blurHPipeline = postPipeline("fs_blur_h");
  const blurVPipeline = postPipeline("fs_blur_v");
  const compositePipeline = postPipeline("fs_composite");
  return {
    postSampler,
    brightPipeline,
    blurHPipeline,
    blurVPipeline,
    compositePipeline,
  };
};

interface RenderTargets {
  resize(): void;
  sceneView: GPUTextureView;
  depthView: GPUTextureView;
  bloomAView: GPUTextureView;
  bloomBView: GPUTextureView;
  brightBG: GPUBindGroup;
  blurHBG: GPUBindGroup;
  blurVBG: GPUBindGroup;
  compositeBG: GPUBindGroup;
}

// Offscreen targets: the scene renders to sceneTex (+depth for the rocks); the
// bloom blur ping-pongs between two half-res textures. All recreated on resize,
// and the post bind groups with them (they reference the views). `state` is
// mutated in place so callers (and the render loop below) always observe the
// latest views/bind groups after a resize().
const createRenderTargets = (
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  format: GPUTextureFormat,
  bloom: BloomPipelines,
): RenderTargets => {
  let sceneTex: GPUTexture | null = null;
  let depthTexture: GPUTexture | null = null;
  let bloomA: GPUTexture | null = null;
  let bloomB: GPUTexture | null = null;

  const tex = (w: number, h: number, fmt: GPUTextureFormat) =>
    device.createTexture({
      size: [w, h],
      format: fmt,
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  const bind = (pipe: GPURenderPipeline, views: GPUTextureView[]) =>
    device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: bloom.postSampler },
        ...views.map((v, i) => ({ binding: i + 1, resource: v })),
      ],
    });

  const state = {} as RenderTargets;

  const ensureTargets = () => {
    for (const t of [sceneTex, depthTexture, bloomA, bloomB]) t?.destroy();
    const w = canvas.width;
    const h = canvas.height;
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    sceneTex = tex(w, h, format);
    state.sceneView = sceneTex.createView();
    depthTexture = device.createTexture({
      size: [w, h],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    state.depthView = depthTexture.createView();
    bloomA = tex(hw, hh, format);
    state.bloomAView = bloomA.createView();
    bloomB = tex(hw, hh, format);
    state.bloomBView = bloomB.createView();
    // bright: scene→A · blurH: A→B · blurV: B→A · composite: scene+A→screen
    state.brightBG = bind(bloom.brightPipeline, [state.sceneView]);
    state.blurHBG = bind(bloom.blurHPipeline, [state.bloomAView]);
    state.blurVBG = bind(bloom.blurVPipeline, [state.bloomBView]);
    state.compositeBG = bind(bloom.compositePipeline, [
      state.sceneView,
      state.bloomAView,
    ]);
  };

  state.resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    ensureTargets();
  };
  state.resize();

  return state;
};

// Writes the shared frame uniforms and the sprite instance buffer for this
// frame (both are GPU-side arrays reused across frames, just overwritten).
const writeFrameUniforms = (
  device: GPUDevice,
  uniformBuffer: GPUBuffer,
  instanceBuffer: GPUBuffer,
  canvas: HTMLCanvasElement,
  time: number,
  instances: Float32Array<ArrayBuffer>,
  instanceCount: number,
) => {
  device.queue.writeBuffer(
    uniformBuffer,
    0,
    new Float32Array([canvas.width, canvas.height, time, DEPTH_SCALE]),
  );
  device.queue.writeBuffer(
    instanceBuffer,
    0,
    instances,
    0,
    instanceCount * FLOATS_PER_INSTANCE,
  );
};

interface ScenePassInput {
  bgPipeline: GPURenderPipeline;
  bgBindGroup: GPUBindGroup;
  rockPass: MeshPass;
  rockInstances: Float32Array<ArrayBuffer>;
  rockCount: number;
  spritePipeline: GPURenderPipeline;
  spriteBindGroup: GPUBindGroup;
  instanceBuffer: GPUBuffer;
  instanceCount: number;
  orbPass: MeshPass;
  orbInstances: Float32Array<ArrayBuffer>;
  orbCount: number;
  shieldPass: MeshPass;
  shieldInstances: Float32Array<ArrayBuffer>;
  shieldCount: number;
}

// Pass 1: the scene, into the offscreen sceneTex (+depth for the rocks).
// Background (behind, no depth) → 3D rocks (depth-tested) → sprites (on top)
// → translucent shields (last, over the ships).
const encodeScenePass = (
  encoder: GPUCommandEncoder,
  targets: RenderTargets,
  input: ScenePassInput,
) => {
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: targets.sceneView,
        loadOp: "clear",
        clearValue: { r: 0.016, g: 0.027, b: 0.039, a: 1 },
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: targets.depthView,
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });
  pass.setPipeline(input.bgPipeline);
  pass.setBindGroup(0, input.bgBindGroup);
  pass.draw(3);
  input.rockPass.draw(pass, input.rockInstances, input.rockCount);
  if (input.instanceCount > 0) {
    pass.setPipeline(input.spritePipeline);
    pass.setBindGroup(0, input.spriteBindGroup);
    pass.setVertexBuffer(0, input.instanceBuffer);
    pass.draw(6, input.instanceCount);
  }
  input.orbPass.draw(pass, input.orbInstances, input.orbCount);
  input.shieldPass.draw(pass, input.shieldInstances, input.shieldCount);
  pass.end();
};

// Bloom: bright-pass (scene→A) → blur H (A→B) → blur V (B→A) → composite
// (scene + blurred brights → swapchain). Each is a fullscreen triangle.
const encodeBloomPasses = (
  encoder: GPUCommandEncoder,
  context: GPUCanvasContext,
  targets: RenderTargets,
  bloom: BloomPipelines,
) => {
  const fsPass = (
    view: GPUTextureView,
    pipe: GPURenderPipeline,
    bg: GPUBindGroup,
  ) => {
    const p = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store",
        },
      ],
    });
    p.setPipeline(pipe);
    p.setBindGroup(0, bg);
    p.draw(3);
    p.end();
  };
  fsPass(targets.bloomAView, bloom.brightPipeline, targets.brightBG);
  fsPass(targets.bloomBView, bloom.blurHPipeline, targets.blurHBG);
  fsPass(targets.bloomAView, bloom.blurVPipeline, targets.blurVBG);
  fsPass(
    context.getCurrentTexture().createView(),
    bloom.compositePipeline,
    targets.compositeBG,
  );
};

interface RenderFnDeps {
  device: GPUDevice;
  context: GPUCanvasContext;
  canvas: HTMLCanvasElement;
  uniformBuffer: GPUBuffer;
  instanceBuffer: GPUBuffer;
  bgPipeline: GPURenderPipeline;
  bgBindGroup: GPUBindGroup;
  rockPass: MeshPass;
  spritePipeline: GPURenderPipeline;
  spriteBindGroup: GPUBindGroup;
  orbPass: MeshPass;
  shieldPass: MeshPass;
  targets: RenderTargets;
  bloom: BloomPipelines;
}

// Builds the per-frame render() closure: write uniforms, encode the scene
// pass, encode the bloom chain, submit. Split out of createRenderer purely so
// the setup function itself stays short — behavior is identical either way.
const createRenderFn = (deps: RenderFnDeps): Renderer["render"] => {
  const { device, context, canvas, uniformBuffer, instanceBuffer } = deps;
  return (
    instances,
    instanceCount,
    rockInstances,
    rockCount,
    shieldInstances,
    shieldCount,
    orbInstances,
    orbCount,
    time,
  ) => {
    writeFrameUniforms(
      device,
      uniformBuffer,
      instanceBuffer,
      canvas,
      time,
      instances,
      instanceCount,
    );

    const encoder = device.createCommandEncoder();

    encodeScenePass(encoder, deps.targets, {
      bgPipeline: deps.bgPipeline,
      bgBindGroup: deps.bgBindGroup,
      rockPass: deps.rockPass,
      rockInstances,
      rockCount,
      spritePipeline: deps.spritePipeline,
      spriteBindGroup: deps.spriteBindGroup,
      instanceBuffer,
      instanceCount,
      orbPass: deps.orbPass,
      orbInstances,
      orbCount,
      shieldPass: deps.shieldPass,
      shieldInstances,
      shieldCount,
    });
    encodeBloomPasses(encoder, context, deps.targets, deps.bloom);

    device.queue.submit([encoder.finish()]);
  };
};

export const createRenderer = (
  { device, context, format, root }: GpuContext,
  canvas: HTMLCanvasElement,
  textureView: GPUTextureView,
  sampler: GPUSampler,
): Renderer => {
  // Shared frame uniforms: resolution + time. Typed schema matches the WGSL
  // `Uniforms { resolution: vec2f, time: f32, _pad: f32 }` (16 bytes).
  const uniformBuffer = root.unwrap(
    root.createBuffer(FrameUniforms).$usage("uniform"),
  );

  const { bgPipeline, bgBindGroup } = createBackgroundPipeline(
    device,
    format,
    uniformBuffer,
  );
  const { instanceBuffer, spritePipeline, spriteBindGroup } =
    createSpritePipeline(
      device,
      format,
      root,
      uniformBuffer,
      textureView,
      sampler,
    );
  const { rockPass, shieldPass, orbPass } = createMeshPasses(
    device,
    format,
    uniformBuffer,
  );
  const bloom = createBloomPipelines(device, format);
  const targets = createRenderTargets(device, canvas, format, bloom);

  return {
    resize: targets.resize,
    render: createRenderFn({
      device,
      context,
      canvas,
      uniformBuffer,
      instanceBuffer,
      bgPipeline,
      bgBindGroup,
      rockPass,
      spritePipeline,
      spriteBindGroup,
      orbPass,
      shieldPass,
      targets,
      bloom,
    }),
  };
};

export const loadCycleTextures = async (
  device: GPUDevice,
): Promise<{ textureView: GPUTextureView; sampler: GPUSampler }> => {
  const loadImage = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.src = url;
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load sprite: ${url}`));
    });

  const loadAndCenter = async (url: string): Promise<HTMLCanvasElement> => {
    const img = await loadImage(url);
    const bitmap = await createImageBitmap(img);
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      // Scale and center using decoded bitmap dimensions
      const maxDim = Math.max(bitmap.width, bitmap.height);
      const scale = 64 / maxDim;
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      ctx.drawImage(bitmap, (64 - w) / 2, (64 - h) / 2, w, h);
    }
    bitmap.close(); // free GPU resources
    return canvas;
  };

  const canvases = await Promise.all(
    SPRITE_URLS.map((url) =>
      loadAndCenter(url).catch((err) => {
        console.warn(err);
        return document.createElement("canvas");
      }),
    ),
  );

  const texture = device.createTexture({
    size: [64, 64, SPRITE_LAYER_COUNT],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  canvases.forEach((canvas, layer) => {
    device.queue.copyExternalImageToTexture(
      { source: canvas, flipY: false },
      { texture, origin: { x: 0, y: 0, z: layer } },
      [64, 64],
    );
  });

  const textureView = texture.createView({ dimension: "2d-array" });
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  return { textureView, sampler };
};
