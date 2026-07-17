// WebGPU renderer: draws a procedural starfield background plus the instanced
// game sprites (ships, asteroids, mines, pickups, explosions, HUD rings).

import * as d from "typegpu/data";
// WGSL lives in .wgsl files (real syntax highlighting) and is imported as text.
import backgroundWGSL from "~/shaders/background.wgsl" with { type: "text" };
import baseWGSL from "~/shaders/base.wgsl" with { type: "text" };
import bloomWGSL from "~/shaders/bloom.wgsl" with { type: "text" };
import orbWGSL from "~/shaders/orb.wgsl" with { type: "text" };
import overlayWGSL from "~/shaders/overlay.wgsl" with { type: "text" };
import plumeWGSL from "~/shaders/plume.wgsl" with { type: "text" };
import rockWGSL from "~/shaders/rock.wgsl" with { type: "text" };
import shieldWGSL from "~/shaders/shield.wgsl" with { type: "text" };
import shipWGSL from "~/shaders/ship.wgsl" with { type: "text" };
import {
  makePlumeMesh,
  makeShipMesh,
  SHIP_CLASSES,
  type ShipClass,
} from "~/ship-parts";
import type { GpuContext } from "./gpu-context";
import {
  type Mesh,
  makeAsteroidMesh,
  makeFacetedOrbMesh,
  makeSphereMesh,
} from "./mesh";
import {
  createMeshPass,
  type InstanceLayout,
  type MeshPass,
} from "./mesh-pass";
import {
  FLOATS_PER_INSTANCE,
  type FrameInstances,
  MAX_BASES,
  MAX_CENTER_PADS,
  MAX_INSTANCES,
  MAX_MESH_SHIPS,
  MAX_ORBS,
  MAX_PLUMES,
  MAX_ROCKS,
  MAX_SHIELDS,
  PLUME_LAYOUT,
  ROCK_LAYOUT,
  SHIELD_LAYOUT,
  SHIP_LAYOUT,
} from "./overlay/frame";
import { SPRITE_LAYER_COUNT, SPRITE_URLS } from "./sprites";

// Instance caps and layouts live in ./overlay/frame — they describe the
// overlay's projection of the World; this module only consumes them.
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

// Cinematic camera for the composite pass: a whole-frame push-in / drift /
// rotate in image space (see bloom.wgsl `Camera`). `fx,fy` is the focus point
// in [0,1] uv held fixed under zoom. Identity = centred, no zoom, no rotation:
// the game renders with it and the frame is untouched; the welcome scene eases
// these to frame the swarm.
export interface CameraView {
  fx: number;
  fy: number;
  zoom: number;
  rot: number;
}
export const CAMERA_IDENTITY: CameraView = {
  fx: 0.5,
  fy: 0.5,
  zoom: 1,
  rot: 0,
};

export interface Renderer {
  render(frame: FrameInstances, time: number, camera: CameraView): void;
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
  basePass: MeshPass;
  centerPadPass: MeshPass;
  shipPasses: Record<ShipClass, MeshPass>;
  plumePass: MeshPass;
}

const createHelperMeshPass = (
  device: GPUDevice,
  format: GPUTextureFormat,
  uniformBuffer: GPUBuffer,
  mesh: Mesh,
  shader: string,
  layout: InstanceLayout<string>,
  max: number,
  depthWrite = true,
  depthCompare: GPUCompareFunction = "less",
  blend?: GPUBlendState,
): MeshPass =>
  createMeshPass(device, {
    format,
    uniformBuffer,
    mesh,
    shader,
    layout,
    maxInstances: max,
    depthFormat: DEPTH_FORMAT,
    depthWrite,
    depthCompare,
    blend,
  });

const createAdditivePass = (
  device: GPUDevice,
  format: GPUTextureFormat,
  ub: GPUBuffer,
  subdiv: number,
  shader: string,
  max: number,
  srcCol: GPUBlendFactor,
  dstCol: GPUBlendFactor,
) =>
  createHelperMeshPass(
    device,
    format,
    ub,
    makeSphereMesh(subdiv),
    shader,
    SHIELD_LAYOUT,
    max,
    false,
    "always",
    {
      color: { srcFactor: srcCol, dstFactor: dstCol },
      alpha: { srcFactor: "one", dstFactor: dstCol },
    },
  );

const createOpaquePasses = (
  device: GPUDevice,
  format: GPUTextureFormat,
  ub: GPUBuffer,
) => ({
  rockPass: createHelperMeshPass(
    device,
    format,
    ub,
    makeAsteroidMesh(2),
    rockWGSL,
    ROCK_LAYOUT,
    MAX_ROCKS,
  ),
  basePass: createHelperMeshPass(
    device,
    format,
    ub,
    makeFacetedOrbMesh(), // 100-face vertex-coloured orb
    baseWGSL,
    ROCK_LAYOUT,
    MAX_BASES,
  ),
  centerPadPass: createHelperMeshPass(
    device,
    format,
    ub,
    makeFacetedOrbMesh(), // same 100-face orb as a base, scaled up by the instance
    baseWGSL,
    ROCK_LAYOUT,
    MAX_CENTER_PADS,
  ),
});

const createTransparentPasses = (
  device: GPUDevice,
  format: GPUTextureFormat,
  ub: GPUBuffer,
) => ({
  shieldPass: createAdditivePass(
    device,
    format,
    ub,
    3,
    shieldWGSL,
    MAX_SHIELDS,
    "src-alpha",
    "one",
  ),
  orbPass: createAdditivePass(
    device,
    format,
    ub,
    2,
    orbWGSL,
    MAX_ORBS,
    "src-alpha",
    "one-minus-src-alpha",
  ),
});

// --- 3D mesh passes: opaque tumbling rocks + additive translucent shields +
// solid-lit power-up orbs. All are adapters of createMeshPass; they differ
// only in mesh, layout, blend, and depth mode. ---
// Hull passes: one per ship class, each drawing its baked part-assembly for
// every ship of that class. Alpha-blended (cloak fades the hull) but still
// depth-written so parts occlude each other correctly.
const createShipPasses = (
  device: GPUDevice,
  format: GPUTextureFormat,
  ub: GPUBuffer,
): Record<ShipClass, MeshPass> => {
  const passes = {} as Record<ShipClass, MeshPass>;
  for (const cls of SHIP_CLASSES) {
    passes[cls] = createHelperMeshPass(
      device,
      format,
      ub,
      makeShipMesh(cls),
      shipWGSL,
      SHIP_LAYOUT,
      MAX_MESH_SHIPS,
      true,
      "less",
      {
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      },
    );
  }
  return passes;
};

const createMeshPasses = (
  device: GPUDevice,
  format: GPUTextureFormat,
  ub: GPUBuffer,
): MeshPasses => ({
  ...createOpaquePasses(device, format, ub),
  ...createTransparentPasses(device, format, ub),
  shipPasses: createShipPasses(device, format, ub),
  // Additive engine-plume cones: no depth write (glow), still occluded by
  // hulls written just before.
  plumePass: createHelperMeshPass(
    device,
    format,
    ub,
    makePlumeMesh(),
    plumeWGSL,
    PLUME_LAYOUT,
    MAX_PLUMES,
    false,
    "less",
    {
      color: { srcFactor: "one", dstFactor: "one" },
      alpha: { srcFactor: "one", dstFactor: "one" },
    },
  ),
});

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

// A post-process bind group: sampler at 0, sampled views at 1.., then any
// uniform buffers after the views. Every bloom stage uses it; the composite
// stage additionally binds the camera uniform at the trailing slot.
const postBindGroup = (
  device: GPUDevice,
  sampler: GPUSampler,
  pipe: GPURenderPipeline,
  views: GPUTextureView[],
  uniforms: GPUBuffer[] = [],
): GPUBindGroup =>
  device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      ...views.map((v, i) => ({ binding: i + 1, resource: v })),
      ...uniforms.map((buffer, i) => ({
        binding: views.length + 1 + i,
        resource: { buffer },
      })),
    ],
  });

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
  cameraBuffer: GPUBuffer,
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
  const bind = (
    pipe: GPURenderPipeline,
    views: GPUTextureView[],
    uniforms: GPUBuffer[] = [],
  ) => postBindGroup(device, bloom.postSampler, pipe, views, uniforms);

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
    state.compositeBG = bind(
      bloom.compositePipeline,
      [state.sceneView, state.bloomAView],
      [cameraBuffer], // camera uniform lands at binding 3 (after the two views)
    );
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

// Writes the shared frame uniforms, the sprite instance buffer and the
// cinematic camera vec4 for this frame (all GPU-side arrays reused across
// frames, just overwritten).
const writeFrameUniforms = (
  deps: RenderFnDeps,
  time: number,
  instances: Float32Array<ArrayBuffer>,
  instanceCount: number,
  camera: CameraView,
) => {
  const { device, canvas } = deps;
  device.queue.writeBuffer(
    deps.uniformBuffer,
    0,
    new Float32Array([canvas.width, canvas.height, time, DEPTH_SCALE]),
  );
  device.queue.writeBuffer(
    deps.instanceBuffer,
    0,
    instances,
    0,
    instanceCount * FLOATS_PER_INSTANCE,
  );
  device.queue.writeBuffer(
    deps.cameraBuffer,
    0,
    new Float32Array([camera.fx, camera.fy, camera.zoom, camera.rot]),
  );
};

interface ScenePassInput {
  bgPipeline: GPURenderPipeline;
  bgBindGroup: GPUBindGroup;
  rockPass: MeshPass;
  spritePipeline: GPURenderPipeline;
  spriteBindGroup: GPUBindGroup;
  instanceBuffer: GPUBuffer;
  orbPass: MeshPass;
  shieldPass: MeshPass;
  basePass: MeshPass;
  centerPadPass: MeshPass;
  shipPasses: Record<ShipClass, MeshPass>;
  plumePass: MeshPass;
  frame: FrameInstances;
}

// Pass 1: the scene, into the offscreen sceneTex (+depth for the rocks).
// Background (behind, no depth) → 3D rocks/bases/pads (depth-tested) → sprites
// (trails/exhaust/FX) → 3D ship hulls (over their own trails) → translucent
// orbs + shields (last, over the ships).
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

  const { frame } = input;
  const drawSprites = (count: number, first: number) => {
    if (count <= 0) return;
    pass.setPipeline(input.spritePipeline);
    pass.setBindGroup(0, input.spriteBindGroup);
    pass.setVertexBuffer(0, input.instanceBuffer);
    pass.draw(6, count, 0, first);
  };

  // Portals are the leading sprite instances, drawn before the 3D passes so
  // rocks, shrapnel and bases fly OVER the portal vortices (background floor).
  drawSprites(frame.portalCount, 0);

  input.rockPass.draw(pass, frame.rockInstances, frame.rockCount);
  input.basePass.draw(pass, frame.baseInstances, frame.baseCount);
  input.centerPadPass.draw(
    pass,
    frame.centerPadInstances,
    frame.centerPadCount,
  );

  // The rest of the overlay (actors, HUD, base/pad glow) over the 3D passes.
  drawSprites(frame.count - frame.portalCount, frame.portalCount);

  // Ship hulls: one instanced draw per class mesh, over the sprite FX layer.
  for (const cls of SHIP_CLASSES) {
    input.shipPasses[cls].draw(
      pass,
      frame.ships.instances[cls],
      frame.ships.counts[cls],
    );
  }
  input.plumePass.draw(pass, frame.ships.plumes, frame.ships.plumeCount);

  input.orbPass.draw(pass, frame.orbInstances, frame.orbCount);
  input.shieldPass.draw(pass, frame.shieldInstances, frame.shieldCount);
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
  cameraBuffer: GPUBuffer;
  bgPipeline: GPURenderPipeline;
  bgBindGroup: GPUBindGroup;
  rockPass: MeshPass;
  spritePipeline: GPURenderPipeline;
  spriteBindGroup: GPUBindGroup;
  orbPass: MeshPass;
  shieldPass: MeshPass;
  basePass: MeshPass;
  centerPadPass: MeshPass;
  shipPasses: Record<ShipClass, MeshPass>;
  plumePass: MeshPass;
  targets: RenderTargets;
  bloom: BloomPipelines;
}

// Builds the per-frame render() closure: write uniforms, encode the scene
// pass, encode the bloom chain, submit. Split out of createRenderer purely so
// the setup function itself stays short — behavior is identical either way.
const createRenderFn =
  (deps: RenderFnDeps): Renderer["render"] =>
  (frame, time, camera) => {
    const { device, context } = deps;
    writeFrameUniforms(deps, time, frame.instances, frame.count, camera);
    const encoder = device.createCommandEncoder();
    encodeScenePass(encoder, deps.targets, { ...deps, frame });
    encodeBloomPasses(encoder, context, deps.targets, deps.bloom);
    device.queue.submit([encoder.finish()]);
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
  const meshPasses = createMeshPasses(device, format, uniformBuffer);
  const bloom = createBloomPipelines(device, format);
  // Cinematic camera uniform, consumed only by the composite pass. One vec4:
  // [focus.x, focus.y, zoom, rot]. Recreated bind groups (on resize) reference it.
  const cameraBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const targets = createRenderTargets(
    device,
    canvas,
    format,
    bloom,
    cameraBuffer,
  );

  return {
    resize: targets.resize,
    render: createRenderFn({
      device,
      context,
      canvas,
      uniformBuffer,
      instanceBuffer,
      cameraBuffer,
      bgPipeline,
      bgBindGroup,
      spritePipeline,
      spriteBindGroup,
      ...meshPasses,
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
