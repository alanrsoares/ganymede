// Grid-accelerated separation kernel — same public shape as SeparationKernel
// (upload / dispatch / read) so the bench can swap it in, but O(n·k): it builds
// a SpatialGrid then runs the query kernel that walks only the 3×3 cell block
// around each ship. One command encoder drives build + query in a single submit
// (separate passes → guaranteed write-before-read ordering across stages).

import { readbackBuffer, readFloats, storageBuffer } from "../buffers";
import { compose, Kernel } from "../kernel";
import lib from "../wgsl/lib.wgsl" with { type: "text" };
import sepGrid from "../wgsl/separation-grid.wgsl" with { type: "text" };
import { SpatialGrid } from "./grid";
import type { Arena } from "./separation";

export class SeparationGridKernel {
  readonly #device: GPUDevice;
  readonly #grid: SpatialGrid;
  readonly #query: Kernel;
  #pos: GPUBuffer | null = null;
  #force: GPUBuffer | null = null;
  #staging: GPUBuffer | null = null;
  #bind: GPUBindGroup | null = null;
  #n = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#grid = new SpatialGrid(device);
    this.#query = new Kernel(device, {
      label: "separation-grid",
      code: compose(lib, sepGrid),
    });
  }

  #realloc(n: number): void {
    this.#pos?.destroy();
    this.#force?.destroy();
    this.#staging?.destroy();
    this.#pos = storageBuffer(this.#device, n * 4 * 4); // vec4<f32> per ship
    this.#force = storageBuffer(this.#device, n * 2 * 4, { readable: true });
    this.#staging = readbackBuffer(this.#device, n * 2 * 4);
    this.#bind = null; // rebuilt after grid.configure below
    this.#n = n;
  }

  upload(positions: Float32Array, n: number, arena: Arena, r: number): void {
    if (n !== this.#n) this.#realloc(n);
    this.#grid.configure(n, arena, r);
    if (!this.#bind && this.#pos && this.#force) {
      this.#bind = this.#query.bindGroupAt(this.#device, [
        { binding: 0, buffer: this.#grid.params },
        { binding: 1, buffer: this.#pos },
        { binding: 2, buffer: this.#grid.cellStart },
        { binding: 3, buffer: this.#grid.counts },
        { binding: 4, buffer: this.#grid.sorted },
        { binding: 5, buffer: this.#force },
      ]);
    }
    if (this.#pos) this.#device.queue.writeBuffer(this.#pos, 0, positions);
  }

  dispatch(): void {
    if (!this.#bind || !this.#pos) return;
    const enc = this.#device.createCommandEncoder();
    this.#grid.encode(enc, this.#pos);
    const pass = enc.beginComputePass();
    this.#query.dispatch(pass, this.#bind, this.#n);
    pass.end();
    this.#device.queue.submit([enc.finish()]);
  }

  async read(): Promise<Float32Array> {
    if (!this.#force || !this.#staging) return new Float32Array(0);
    return readFloats(
      this.#device,
      this.#force,
      this.#staging,
      this.#n * 2 * 4,
    );
  }
}
