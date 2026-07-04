// WebGPU Game of Life engine: ping-pong storage buffers, pattern injection,
// and region readback. Mirrors the CPU reference in ~/domain/gol.ts, which
// serves as its test oracle.

import type { Cell } from "~/domain/gol";

const golComputeWGSL = /* wgsl */ `
struct Grid { w: u32, h: u32 }
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<storage, read> cellsIn: array<u32>;
@group(0) @binding(2) var<storage, read_write> cellsOut: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= grid.w || gid.y >= grid.h) { return; }
  let w = i32(grid.w);
  let h = i32(grid.h);
  var count = 0u;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let x = (i32(gid.x) + dx + w) % w;
      let y = (i32(gid.y) + dy + h) % h;
      count += cellsIn[u32(y) * grid.w + u32(x)];
    }
  }
  let idx = gid.y * grid.w + gid.x;
  let alive = cellsIn[idx] == 1u;
  let survives = alive && (count == 2u || count == 3u);
  let born = !alive && count == 3u;
  cellsOut[idx] = select(0u, 1u, survives || born);
}
`;

const ALIVE = new Uint32Array([1]);

export interface GolEngine {
  readonly width: number;
  readonly height: number;
  readonly cellBuffers: readonly [GPUBuffer, GPUBuffer];
  readonly gridBuffer: GPUBuffer;
  currentIndex(): number;
  generation(): number;
  /** Advances n generations in a single command submission. */
  step(n?: number): void;
  /** Sets cells alive in the current generation (coordinates wrap). */
  inject(cells: Iterable<Cell>): void;
  /** Reads back a rectangular region of the current generation. */
  readRegion(x: number, y: number, w: number, h: number): Promise<Uint32Array>;
}

export const createGolEngine = (
  device: GPUDevice,
  width: number,
  height: number,
  seed: Iterable<Cell> = [],
): GolEngine => {
  const gridBuffer = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(gridBuffer, 0, new Uint32Array([width, height]));

  const cellBuffers = [0, 1].map(() =>
    device.createBuffer({
      size: width * height * 4,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    }),
  ) as [GPUBuffer, GPUBuffer];

  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: device.createShaderModule({ code: golComputeWGSL }),
      entryPoint: "main",
    },
  });
  const bindGroups = [0, 1].map((i) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: gridBuffer } },
        { binding: 1, resource: { buffer: cellBuffers[i] } },
        { binding: 2, resource: { buffer: cellBuffers[1 - i] } },
      ],
    }),
  );

  let current = 0;
  let generation = 0;

  const inject = (cells: Iterable<Cell>) => {
    for (const [x, y] of cells) {
      const wx = ((x % width) + width) % width;
      const wy = ((y % height) + height) % height;
      device.queue.writeBuffer(
        cellBuffers[current],
        (wy * width + wx) * 4,
        ALIVE,
      );
    }
  };

  inject(seed);

  return {
    width,
    height,
    cellBuffers,
    gridBuffer,
    currentIndex: () => current,
    generation: () => generation,
    inject,
    step: (n = 1) => {
      if (n <= 0) return;
      const encoder = device.createCommandEncoder();
      for (let i = 0; i < n; i++) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroups[current]);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        current = 1 - current;
      }
      device.queue.submit([encoder.finish()]);
      generation += n;
    },
    readRegion: async (x, y, w, h) => {
      const staging = device.createBuffer({
        size: w * h * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      const encoder = device.createCommandEncoder();
      for (let row = 0; row < h; row++) {
        encoder.copyBufferToBuffer(
          cellBuffers[current],
          ((y + row) * width + x) * 4,
          staging,
          row * w * 4,
          w * 4,
        );
      }
      device.queue.submit([encoder.finish()]);

      await staging.mapAsync(GPUMapMode.READ);
      const out = new Uint32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      staging.destroy();
      return out;
    },
  };
};
