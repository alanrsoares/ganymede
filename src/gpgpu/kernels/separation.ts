// Separation kernel wrapper — composes lib + separation WGSL, owns the
// persistent buffers (positions in, force out, staging for readback) and the
// per-dispatch params. Buffers are (re)allocated only when the ship count
// changes, so steady-state ticks just overwrite them — the residency the plan
// leans on. `run` = upload + dispatch + readback for one-shot use; the bench
// drives upload/dispatch/read separately to isolate the compute timing.

import {
  readbackBuffer,
  readFloats,
  storageBuffer,
  uniformBuffer,
} from "~/gpgpu/buffers";
import { compose, Kernel } from "~/gpgpu/kernel";
import lib from "~/gpgpu/wgsl/lib.wgsl" with { type: "text" };
import separation from "~/gpgpu/wgsl/separation.wgsl" with { type: "text" };

export interface Arena {
  readonly w: number;
  readonly h: number;
}

const PARAMS_BYTES = 16; // u32 n + 3×f32 (arenaW, arenaH, r)

export class SeparationKernel {
  readonly #device: GPUDevice;
  readonly #kernel: Kernel;
  readonly #params: GPUBuffer;
  #pos: GPUBuffer | null = null;
  #force: GPUBuffer | null = null;
  #staging: GPUBuffer | null = null;
  #bind: GPUBindGroup | null = null;
  #n = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#kernel = new Kernel(device, {
      label: "separation",
      code: compose(lib, separation),
    });
    this.#params = uniformBuffer(device, PARAMS_BYTES);
  }

  #realloc(n: number): void {
    this.#pos?.destroy();
    this.#force?.destroy();
    this.#staging?.destroy();
    this.#pos = storageBuffer(this.#device, n * 4 * 4); // vec4<f32> per ship
    this.#force = storageBuffer(this.#device, n * 2 * 4, { readable: true });
    this.#staging = readbackBuffer(this.#device, n * 2 * 4);
    this.#bind = this.#kernel.bindGroup(this.#device, [
      this.#params,
      this.#pos,
      this.#force,
    ]);
    this.#n = n;
  }

  // positions: Float32Array of length n*4, laid out [x, y, _, _] per ship.
  upload(positions: Float32Array, n: number, arena: Arena, r: number): void {
    if (n !== this.#n) this.#realloc(n);
    const p = new ArrayBuffer(PARAMS_BYTES);
    new Uint32Array(p, 0, 1)[0] = n;
    new Float32Array(p, 4, 3).set([arena.w, arena.h, r]);
    this.#device.queue.writeBuffer(this.#params, 0, p);
    if (this.#pos) this.#device.queue.writeBuffer(this.#pos, 0, positions);
  }

  dispatch(): void {
    if (!this.#bind) return;
    const enc = this.#device.createCommandEncoder();
    const pass = enc.beginComputePass();
    this.#kernel.dispatch(pass, this.#bind, this.#n);
    pass.end();
    this.#device.queue.submit([enc.finish()]);
  }

  // Read the force buffer back to the CPU as a Float32Array of length n*2.
  async read(): Promise<Float32Array> {
    return !this.#force || !this.#staging
      ? new Float32Array(0)
      : readFloats(this.#device, this.#force, this.#staging, this.#n * 2 * 4);
  }
}
