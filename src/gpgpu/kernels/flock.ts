// FlockKernel — separation + align + cohere in one grid-accelerated pass. Owns
// the two SoA input buffers (posHead [x,y,dx,dy], velTeam [vx,vy,team,_]), the
// force output, and a SpatialGrid it drives before the flock query. The grid is
// sized to max(sepR, flockR) so the shared 3×3 walk covers both interaction
// radii. Demonstrates multi-term GPU residency: three steer terms accumulate
// into one force buffer, one readback per tick.

import {
  readbackBuffer,
  readFloats,
  storageBuffer,
  uniformBuffer,
} from "~/gpgpu/buffers";
import { compose, Kernel } from "~/gpgpu/kernel";
import flock from "~/gpgpu/wgsl/flock.wgsl" with { type: "text" };
import lib from "~/gpgpu/wgsl/lib.wgsl" with { type: "text" };
import { SpatialGrid } from "./grid";
import type { Arena } from "./separation";

const FLOCK_PARAMS_BYTES = 32; // 5×f32 gains/radii + 3×f32 pad

export interface FlockTuning {
  readonly sepR: number;
  readonly sepGain: number;
  readonly flockR: number;
  readonly alignGain: number;
  readonly cohereGain: number;
}

export class FlockKernel {
  readonly #grid: SpatialGrid;
  readonly #query: Kernel;
  readonly #flockParams: GPUBuffer;
  #posHead: GPUBuffer | null = null;
  #velTeam: GPUBuffer | null = null;
  #force: GPUBuffer | null = null;
  #staging: GPUBuffer | null = null;
  #bind: GPUBindGroup | null = null;
  #n = 0;

  constructor(private readonly device: GPUDevice) {
    this.#grid = new SpatialGrid(device);
    this.#query = new Kernel(device, {
      label: "flock",
      code: compose(lib, flock),
    });
    this.#flockParams = uniformBuffer(device, FLOCK_PARAMS_BYTES);
  }

  #realloc(n: number): void {
    this.#posHead?.destroy();
    this.#velTeam?.destroy();
    this.#force?.destroy();
    this.#staging?.destroy();
    this.#posHead = storageBuffer(this.device, n * 4 * 4);
    this.#velTeam = storageBuffer(this.device, n * 4 * 4);
    this.#force = storageBuffer(this.device, n * 2 * 4, { readable: true });
    this.#staging = readbackBuffer(this.device, n * 2 * 4);
    this.#bind = null;
    this.#n = n;
  }

  // posHead: [x,y,dx,dy] per ship; velTeam: [vx,vy,team,0] per ship (both n*4).
  upload(
    posHead: Float32Array,
    velTeam: Float32Array,
    n: number,
    arena: Arena,
    t: FlockTuning,
  ): void {
    if (n !== this.#n) this.#realloc(n);
    this.#grid.configure(n, arena, Math.max(t.sepR, t.flockR));
    if (!this.#bind && this.#posHead && this.#velTeam && this.#force) {
      this.#bind = this.#query.bindGroupAt(this.device, [
        { binding: 0, buffer: this.#grid.params },
        { binding: 1, buffer: this.#posHead },
        { binding: 2, buffer: this.#grid.cellStart },
        { binding: 3, buffer: this.#grid.counts },
        { binding: 4, buffer: this.#grid.sorted },
        { binding: 5, buffer: this.#force },
        { binding: 6, buffer: this.#velTeam },
        { binding: 7, buffer: this.#flockParams },
      ]);
    }
    const p = new Float32Array([
      t.sepR,
      t.sepGain,
      t.flockR,
      t.alignGain,
      t.cohereGain,
      0,
      0,
      0,
    ]);
    this.device.queue.writeBuffer(this.#flockParams, 0, p);
    if (this.#posHead) this.device.queue.writeBuffer(this.#posHead, 0, posHead);
    if (this.#velTeam) this.device.queue.writeBuffer(this.#velTeam, 0, velTeam);
  }

  dispatch(): void {
    if (!this.#bind || !this.#posHead) return;
    const enc = this.device.createCommandEncoder();
    this.#grid.encode(enc, this.#posHead);
    const pass = enc.beginComputePass();
    this.#query.dispatch(pass, this.#bind, this.#n);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  async read(): Promise<Float32Array> {
    return !this.#force || !this.#staging
      ? new Float32Array(0)
      : readFloats(this.device, this.#force, this.#staging, this.#n * 2 * 4);
  }
}
