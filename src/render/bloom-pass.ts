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

const createTargets = (
  gpu: Gpu,
  width: number,
  height: number,
  format: GPUTextureFormat,
): BloomTargets => {
  const halfWidth = Math.max(1, width >> 1);
  const halfHeight = Math.max(1, height >> 1);
  return {
    sceneTarget: target(gpu, { size: [width, height], format }),
    bloomA: target(gpu, { size: [halfWidth, halfHeight], format }),
    bloomB: target(gpu, { size: [halfWidth, halfHeight], format }),
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
        cam: { focus: [0.5, 0.5], zoom: 1, rot: 0 },
      },
    }),
  };
};

export const createBloomPassManager = (
  gpu: Gpu,
  canvas: HTMLCanvasElement,
  format: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
): BloomPassManager => {
  const canvasSurface: Surface = surface(gpu, canvas);
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);

  const targets = createTargets(gpu, width, height, format);
  let depth = createDepthBuffer(gpu.device.gpu, width, height, depthFormat);
  const draws = createBloomDraws(gpu, targets);

  const resize = (newWidth: number, newHeight: number) => {
    const w = Math.max(1, newWidth);
    const h = Math.max(1, newHeight);
    targets.sceneTarget.resize([w, h]);
    targets.bloomA.resize([Math.max(1, w >> 1), Math.max(1, h >> 1)]);
    targets.bloomB.resize([Math.max(1, w >> 1), Math.max(1, h >> 1)]);

    depth.depthTexture.destroy();
    depth = createDepthBuffer(gpu.device.gpu, w, h, depthFormat);
  };

  const render = (camera: CameraView) => {
    draws.brightDraw.draw(targets.bloomA);
    draws.blurHDraw.draw(targets.bloomB);
    draws.blurVDraw.draw(targets.bloomA);
    draws.compositeDraw.set({
      cam: {
        focus: [camera.fx, camera.fy],
        zoom: camera.zoom,
        rot: camera.rot,
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
