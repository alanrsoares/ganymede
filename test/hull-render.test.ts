import { describe, expect, test } from "bun:test";
import { init as initNode } from "vgpu/node";
import { makeShipMesh } from "~/hull/bake";
import { SHIP_CLASSES, type ShipClass } from "~/hull/catalog";
import { createMeshPass, type MeshPass } from "~/render/mesh-pass";
import { SHIP_LAYOUT } from "~/render/overlay/frame";
import { orthoPixels, type ViewProj } from "~/render/view";
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

const DEPTH_SCALE = 0.0016;

const countVisiblePixels = (data: Uint8Array): number => {
  let count = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (data[y * ROW_BYTES + x * 4 + 3] > 0) count++;
    }
  }
  return count;
};

// Centre of mass of the drawn pixels — how we tell that a view moved the hull
// rather than merely still drawing one.
const centroid = (data: Uint8Array): { x: number; y: number } => {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (data[y * ROW_BYTES + x * 4 + 3] > 0) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return n === 0 ? { x: 0, y: 0 } : { x: sx / n, y: sy / n };
};

const renderAndReadback = async (
  device: GPUDevice,
  meshPass: MeshPass,
  colorTex: GPUTexture,
  depthTex: GPUTexture,
  instance: Float32Array,
): Promise<Uint8Array> => {
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

  meshPass.draw(pass, instance, 1);
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
  const pixels = new Uint8Array(staging.getMappedRange()).slice();
  staging.unmap();
  staging.destroy();
  return pixels;
};

// One headless draw of `cls` under `view`, returning the raw pixels.
const drawHull = async (
  cls: ShipClass,
  view: ViewProj,
  instance: Float32Array = SHIP_INSTANCE,
): Promise<Uint8Array> => {
  const gpu = await initNode();
  const device = gpu.device.gpu;

  const ub = device.createBuffer({
    // resolution + time + pad, then the shared view-projection mat4x4f.
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    ub,
    0,
    new Float32Array([WIDTH, HEIGHT, 0, 0, ...view]),
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

  const pixels = await renderAndReadback(
    device,
    meshPass,
    colorTex,
    depthTex,
    instance,
  );

  depthTex.destroy();
  colorTex.destroy();
  ub.destroy();
  gpu.dispose();
  return pixels;
};

describe("headless hull rendering with vgpu", () => {
  test.each([
    ...SHIP_CLASSES,
  ])("%s renders visible geometry", async (cls: ShipClass) => {
    const view = orthoPixels(WIDTH, HEIGHT, DEPTH_SCALE);
    expect(countVisiblePixels(await drawHull(cls, view))).toBeGreaterThan(100);
  });

  // The seam's whole point: one uniform moves every pass. Shift the view a
  // quarter screen right and the same hull draws a quarter screen right.
  test("a non-identity view translates the scene", async () => {
    const identity = orthoPixels(WIDTH, HEIGHT, DEPTH_SCALE);
    const shifted = new Float32Array(identity);
    const dx = WIDTH / 4;
    shifted[12] += (2 / WIDTH) * dx;

    // Half-size hull so the shifted copy still fits inside the 64px target —
    // a clipped silhouette would drag the centroid and hide the real delta.
    const small = new Float32Array(SHIP_INSTANCE);
    small[2] = 12;

    const before = centroid(await drawHull("fighter", identity, small));
    const after = centroid(await drawHull("fighter", shifted, small));

    expect(after.x - before.x).toBeCloseTo(dx, 0);
    expect(after.y - before.y).toBeCloseTo(0, 0);
  });
});
