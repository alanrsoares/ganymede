import { describe, expect, test } from "bun:test";
import { init as initNode } from "vgpu/node";
import { makeShipMesh } from "~/hull/bake";
import { SHIP_CLASSES, type ShipClass } from "~/hull/catalog";
import { createMeshPass, type MeshPass } from "~/render/mesh-pass";
import { SHIP_LAYOUT } from "~/render/overlay/frame";
import shipWGSL from "~/shaders/ship.wgsl" with { type: "text" };

const WIDTH = 64;
const HEIGHT = 64;
const ROW_BYTES = Math.ceil((WIDTH * 4) / 256) * 256;

const SHIP_INSTANCE = new Float32Array([
  WIDTH / 2,
  HEIGHT / 2,
  26,
  0,
  0,
  0.35,
  0,
  0,
  0.05,
  3.0,
  0.4,
  0,
  1,
  1,
  1,
  1,
]);

const countVisiblePixels = (data: Uint8Array): number => {
  let count = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (data[y * ROW_BYTES + x * 4 + 3] > 0) count++;
    }
  }
  return count;
};

const renderAndReadback = async (
  device: GPUDevice,
  meshPass: MeshPass,
  colorTex: GPUTexture,
  depthTex: GPUTexture,
): Promise<number> => {
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
    depthStencilAttachment: {
      view: depthTex.createView(),
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });

  meshPass.draw(pass, SHIP_INSTANCE, 1);
  pass.end();

  const staging = device.createBuffer({
    size: ROW_BYTES * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  encoder.copyTextureToBuffer(
    { texture: colorTex },
    { buffer: staging, bytesPerRow: ROW_BYTES },
    [WIDTH, HEIGHT],
  );
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const visible = countVisiblePixels(new Uint8Array(staging.getMappedRange()));
  staging.unmap();
  staging.destroy();
  return visible;
};

describe("headless hull rendering with vgpu", () => {
  test.each([
    ...SHIP_CLASSES,
  ])("%s renders visible geometry", async (cls: ShipClass) => {
    const gpu = await initNode();
    const device = gpu.device.gpu;

    const ub = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      ub,
      0,
      new Float32Array([WIDTH, HEIGHT, 0, 0.0016]),
    );

    const depthTex = device.createTexture({
      size: [WIDTH, HEIGHT],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const colorTex = device.createTexture({
      size: [WIDTH, HEIGHT],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.TEXTURE_BINDING,
    });

    const meshPass = createMeshPass(device, {
      format: "rgba8unorm",
      uniformBuffer: ub,
      mesh: makeShipMesh(cls),
      shader: shipWGSL,
      layout: SHIP_LAYOUT,
      maxInstances: 1,
      depthFormat: "depth24plus",
      depthWrite: true,
      depthCompare: "less",
    });

    const visible = await renderAndReadback(
      device,
      meshPass,
      colorTex,
      depthTex,
    );
    expect(visible).toBeGreaterThan(100);

    depthTex.destroy();
    colorTex.destroy();
    ub.destroy();
    gpu.dispose();
  });
});
