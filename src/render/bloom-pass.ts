import {
  type Draw,
  draw,
  frame,
  type Gpu,
  type Surface,
  sampler,
  surface,
  type Target,
  target,
} from "vgpu";
import bloomWGSL from "~/shaders/bloom.wgsl" with { type: "text" };
import type { CameraView } from "./gpu";
import type { QualitySettings } from "./quality";

// How far below the scene resolution the blur chain runs, per bloom tier. "off"
// still allocates (the composite always binds tex1) but at a size small enough
// that the allocation is free — the chain that fills it never runs.
const BLOOM_DIVISOR: Record<QualitySettings["bloom"], number> = {
  off: 16,
  quarter: 4,
  half: 2,
};

// Additive weight of the blurred brights in the composite. Was a literal in
// bloom.wgsl; now a uniform so the "off" tier can zero it.
const BLOOM_STRENGTH = 1.15;

export interface BloomPassManager {
  readonly sceneTarget: Target;
  readonly depthTexture: GPUTexture;
  readonly depthView: GPUTextureView;
  resize(width: number, height: number): void;
  render(camera: CameraView): void;
}

interface BloomTargets {
  readonly sceneTarget: Target;
  readonly bloomA: Target;
  readonly bloomB: Target;
}

/** Blur-chain size for a scene of `width`x`height` at the given bloom tier. */
const blurSize = (
  width: number,
  height: number,
  bloom: QualitySettings["bloom"],
): [number, number] => {
  const d = BLOOM_DIVISOR[bloom];
  return [
    Math.max(1, Math.floor(width / d)),
    Math.max(1, Math.floor(height / d)),
  ];
};

const createTargets = (
  gpu: Gpu,
  width: number,
  height: number,
  format: GPUTextureFormat,
  bloom: QualitySettings["bloom"],
): BloomTargets => {
  const size = blurSize(width, height, bloom);
  return {
    sceneTarget: target(gpu, { size: [width, height], format }),
    bloomA: target(gpu, { size, format }),
    bloomB: target(gpu, { size, format }),
  };
};

const createDepthBuffer = (
  device: GPUDevice,
  width: number,
  height: number,
  format: GPUTextureFormat,
) => {
  const depthTexture = device.createTexture({
    size: [width, height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return { depthTexture, depthView: depthTexture.createView() };
};

interface BloomDraws {
  brightDraw: Draw;
  blurHDraw: Draw;
  blurVDraw: Draw;
  compositeDraw: Draw;
}

const createBloomDraws = (gpu: Gpu, targets: BloomTargets): BloomDraws => {
  const postSampler = sampler(gpu, {
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  return {
    brightDraw: draw(gpu, {
      shader: bloomWGSL,
      entry: { vertex: "vs", fragment: "fs_bright" },
      set: { samp: postSampler, tex0: targets.sceneTarget },
    }),
    blurHDraw: draw(gpu, {
      shader: bloomWGSL,
      entry: { vertex: "vs", fragment: "fs_blur_h" },
      set: { samp: postSampler, tex0: targets.bloomA },
    }),
    blurVDraw: draw(gpu, {
      shader: bloomWGSL,
      entry: { vertex: "vs", fragment: "fs_blur_v" },
      set: { samp: postSampler, tex0: targets.bloomB },
    }),
    compositeDraw: draw(gpu, {
      shader: bloomWGSL,
      entry: { vertex: "vs", fragment: "fs_composite" },
      set: {
        samp: postSampler,
        tex0: targets.sceneTarget,
        tex1: targets.bloomA,
        cam: { focus: [0.5, 0.5], zoom: 1, rot: 0, strength: BLOOM_STRENGTH },
      },
    }),
  };
};

export const createBloomPassManager = (
  gpu: Gpu,
  canvas: HTMLCanvasElement,
  format: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  settings: () => QualitySettings,
): BloomPassManager => {
  // Auto-resize is off because the graphics tier — not the CSS box — decides
  // the backing-store size. vgpu otherwise re-derives it from the layout at
  // every frame clock tick, which would silently undo `renderScale`/`dprCap`
  // (and leave the view matrix built for a size the canvas no longer has).
  // `resize` below is then the single authority, driven by the renderer.
  const canvasSurface: Surface = surface(gpu, canvas, { autoResize: false });
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);

  const targets = createTargets(gpu, width, height, format, settings().bloom);
  // The size the blur targets were last sized for, so a quality change can be
  // detected without the renderer having to tell us it happened.
  let lastBloom = settings().bloom;
  let depth = createDepthBuffer(gpu.device.gpu, width, height, depthFormat);
  const draws = createBloomDraws(gpu, targets);

  const resize = (newWidth: number, newHeight: number) => {
    const w = Math.max(1, newWidth);
    const h = Math.max(1, newHeight);
    lastBloom = settings().bloom;
    const size = blurSize(w, h, lastBloom);
    canvasSurface.resize([w, h]);
    targets.sceneTarget.resize([w, h]);
    targets.bloomA.resize(size);
    targets.bloomB.resize(size);

    depth.depthTexture.destroy();
    depth = createDepthBuffer(gpu.device.gpu, w, h, depthFormat);
  };

  const render = (camera: CameraView) => {
    const q = settings();
    // A tier change that didn't come with a window resize still has to re-size
    // the blur chain; the renderer's resize() normally does this, this covers
    // the case where the drawing-buffer size happens to be unchanged.
    if (q.bloom !== lastBloom) {
      const [w, h] = targets.sceneTarget.size;
      resize(w, h);
    }
    if (q.bloom !== "off") {
      draws.brightDraw.draw(targets.bloomA);
      // Each extra pair widens the glow; ping-pongs A -> B -> A, so any count
      // ends with the result back in bloomA (what the composite samples).
      for (let i = 0; i < q.blurPasses; i++) {
        draws.blurHDraw.draw(targets.bloomB);
        draws.blurVDraw.draw(targets.bloomA);
      }
    }
    draws.compositeDraw.set({
      cam: {
        focus: [camera.fx, camera.fy],
        zoom: camera.zoom,
        rot: camera.rot,
        strength: q.bloom === "off" ? 0 : BLOOM_STRENGTH,
      },
    });
    frame(gpu, (f) => {
      f.pass(canvasSurface, draws.compositeDraw);
    });
  };

  return {
    get sceneTarget() {
      return targets.sceneTarget;
    },
    get depthTexture() {
      return depth.depthTexture;
    },
    get depthView() {
      return depth.depthView;
    },
    resize,
    render,
  };
};
