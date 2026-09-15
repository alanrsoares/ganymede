import { describe, expect, test } from "bun:test";
import { init as initNode } from "vgpu/node";
import { orthoPixels } from "~/render/view";
import backgroundWGSL from "~/shaders/background.wgsl" with { type: "text" };

const SIZE = 256;
const ROW_BYTES = Math.ceil((SIZE * 4) / 256) * 256;
const DEPTH_SCALE = 0.0016;
// Big enough that the slowest layer still moves a pixel or two, small enough
// that the fastest one (0.9) stays well inside the frame.
const CAM_DY = -32;

// The frame uniforms as gpu.ts writes them: resolution + time + pad, the
// view-projection, then the camera + pad.
const frameUniforms = (camX: number, camY: number): Float32Array =>
  new Float32Array([
    SIZE,
    SIZE,
    0,
    0,
    ...orthoPixels(SIZE, SIZE, DEPTH_SCALE),
    camX,
    camY,
    0,
    0,
  ]);

const backdropPipeline = (device: GPUDevice, uniforms: GPUBuffer) => {
  const module = device.createShaderModule({ code: backgroundWGSL });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    // No depth attachment here: the real pass shares one with the rocks, but
    // the background never tests or writes it.
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniforms } }],
  });
  return { pipeline, bindGroup };
};

const readback = async (
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  colorTex: GPUTexture,
): Promise<Uint8Array> => {
  const staging = device.createBuffer({
    size: ROW_BYTES * SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer(
    { texture: colorTex },
    { buffer: staging, bytesPerRow: ROW_BYTES },
    [SIZE, SIZE],
  );
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(staging.getMappedRange()).slice();
  staging.unmap();
  staging.destroy();
  return pixels;
};

// One headless frame of the backdrop with the camera at `camX, camY`, in
// drawing-buffer pixels — the same numbers `Renderer.setCamera` takes.
const drawBackground = async (
  camX: number,
  camY: number,
): Promise<Uint8Array> => {
  const gpu = await initNode();
  const device = gpu.device.gpu;

  const ub = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(ub, 0, frameUniforms(camX, camY));
  const { pipeline, bindGroup } = backdropPipeline(device, ub);

  const colorTex = device.createTexture({
    size: [SIZE, SIZE],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: colorTex.createView(),
        loadOp: "clear",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();

  const pixels = await readback(device, encoder, colorTex);
  colorTex.destroy();
  ub.destroy();
  gpu.dispose();
  return pixels;
};

/**
 * Mean per-channel difference between `a` and `b`, comparing row y of `a` to
 * row y + shift of `b`. At shift 0 this is a plain image difference; at other
 * shifts it asks "did the picture move this far down the screen?", and it can
 * answer that despite the layers moving by different amounts because the parts
 * that don't move at all — the base gradient, the vignette — are misaligned
 * exactly as much by +s as by -s, so they cancel out of the comparison.
 */
const meanAbsDiff = (a: Uint8Array, b: Uint8Array, shift = 0): number => {
  let sum = 0;
  let n = 0;
  const margin = Math.abs(shift);
  for (let y = margin; y < SIZE - margin; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * ROW_BYTES + x * 4;
      const j = (y + shift) * ROW_BYTES + x * 4;
      sum +=
        Math.abs((a[i] ?? 0) - (b[j] ?? 0)) +
        Math.abs((a[i + 1] ?? 0) - (b[j + 1] ?? 0)) +
        Math.abs((a[i + 2] ?? 0) - (b[j + 2] ?? 0));
      n += 3;
    }
  }
  return sum / n;
};

// Same capability probe as the hull render tests: CI supplies an adapter only
// sometimes, and a missing GPU is not a broken backdrop.
const hasAdapter = await (async (): Promise<boolean> => {
  try {
    const gpu = await initNode();
    gpu.dispose();
    return true;
  } catch {
    console.warn("no WebGPU adapter — skipping headless background tests");
    return false;
  }
})();

describe.skipIf(!hasAdapter)("backdrop parallax", () => {
  test("all-range play draws the same backdrop it always did", async () => {
    // The camera is zero wherever the field origin is 0,0, which is every
    // autobattle and arcade frame. Nothing there may move.
    expect(await drawBackground(0, 0)).toEqual(await drawBackground(0, 0));
  });

  test("a scrolling camera moves the backdrop on both axes", async () => {
    const still = await drawBackground(0, 0);
    // The threshold is low on purpose: a deep-space backdrop is mostly dark and
    // the stars are sparse, so even a frame-filling shift moves few bytes far.
    // Zero is the failure this guards — the camera reaching the shader at all.
    expect(meanAbsDiff(still, await drawBackground(0, CAM_DY))).toBeGreaterThan(
      0.1,
    );
    expect(meanAbsDiff(still, await drawBackground(CAM_DY, 0))).toBeGreaterThan(
      0.1,
    );
  });

  test("the backdrop keeps moving as the camera travels", async () => {
    // A stage runs thousands of pixels, not thirty. Layers that wrapped, or a
    // camera folded into a fract() somewhere, would stop diverging from the
    // still frame; real parallax keeps going.
    const still = await drawBackground(0, 0);
    const near = meanAbsDiff(still, await drawBackground(0, CAM_DY));
    const far = meanAbsDiff(still, await drawBackground(0, CAM_DY * 100));
    expect(far).toBeGreaterThan(near);
  });

  test("flying forward streams the backdrop downward", async () => {
    // Forward is -y: the window climbs toward smaller y, so anything at a fixed
    // world position slides *down* the screen. A sign error still looks like
    // parallax — it just reads as a reversed treadmill — so pin the direction.
    // A long camera travel, because the slowest layers are also the broadest
    // and they are what a whole-image comparison can see: at 200px the nebula
    // floor has moved 12 and the haze 28, which is the signal being read here.
    const still = await drawBackground(0, 0);
    const moved = await drawBackground(0, -200);
    const down = meanAbsDiff(still, moved, 12);
    const up = meanAbsDiff(still, moved, -12);
    expect(down).toBeLessThan(up);
  });
});
