// CrossPairKernel — grid-accelerated cross-set broad-phase (P6). Set B (bullets/
// missiles/shrapnel) is queried against a grid built over set A (ships/rocks),
// emitting (bIdx, aIdx) candidate pairs within a fixed query radius. The CPU
// consumes the sorted list and runs the exact per-pair narrow-phase + mutation,
// so the sim stays deterministic and golden-test-green. Generalises P5's single-
// set pairing to the projectile/hazard loops (bullet×ship, missile×ship, …).
//
// Capacity is explicit (read() flags `overflow`) — no silent truncation.

import {
  readbackBuffer,
  readU32,
  storageBuffer,
  uniformBuffer,
} from "~/gpgpu/buffers";
import { compose, Kernel } from "~/gpgpu/kernel";
import crossWgsl from "~/gpgpu/wgsl/cross.wgsl" with { type: "text" };
import lib from "~/gpgpu/wgsl/lib.wgsl" with { type: "text" };
import { SpatialGrid } from "./grid";
import type { PairResult } from "./pairs";
import type { Arena } from "./separation";

export class CrossPairKernel {
  readonly #grid: SpatialGrid;
  readonly #query: Kernel;
  readonly #qcap: GPUBuffer;
  #posA: GPUBuffer | null = null;
  #posB: GPUBuffer | null = null;
  #pairCount: GPUBuffer | null = null;
  #pairs: GPUBuffer | null = null;
  #countStaging: GPUBuffer | null = null;
  #pairStaging: GPUBuffer | null = null;
  #bind: GPUBindGroup | null = null;
  #nA = 0;
  #nB = 0;
  #capacity = 0;

  constructor(private readonly device: GPUDevice) {
    this.#grid = new SpatialGrid(device);
    this.#query = new Kernel(device, {
      label: "cross",
      code: compose(lib, crossWgsl),
    });
    this.#qcap = uniformBuffer(device, 16); // u32 maxPairs + u32 mCount + pad
  }

  private realloc(nA: number, nB: number, capacity: number): void {
    if (nA !== this.#nA) {
      this.#posA?.destroy();
      this.#posA = storageBuffer(this.device, nA * 4 * 4);
      this.#nA = nA;
    }
    if (nB !== this.#nB) {
      this.#posB?.destroy();
      this.#posB = storageBuffer(this.device, nB * 4 * 4);
      this.#nB = nB;
    }
    if (capacity !== this.#capacity) {
      this.#pairCount?.destroy();
      this.#pairs?.destroy();
      this.#countStaging?.destroy();
      this.#pairStaging?.destroy();
      this.#pairCount = storageBuffer(this.device, 4, { readable: true });
      this.#pairs = storageBuffer(this.device, capacity * 2 * 4, {
        readable: true,
      });
      this.#countStaging = readbackBuffer(this.device, 4);
      this.#pairStaging = readbackBuffer(this.device, capacity * 2 * 4);
      this.#capacity = capacity;
    }
    this.#bind = null;
  }

  // posA: set queried (grid is built over it), n*4 [x,y,_,_]. posB: query points,
  // m*4. r: fixed query radius (grid cell is sized to it). maxPairs: capacity.
  upload(
    posA: Float32Array,
    posB: Float32Array,
    nA: number,
    nB: number,
    arena: Arena,
    r: number,
    maxPairs: number,
  ): void {
    if (nA !== this.#nA || nB !== this.#nB || maxPairs !== this.#capacity)
      this.realloc(nA, nB, maxPairs);
    this.#grid.configure(nA, arena, r);
    this.device.queue.writeBuffer(
      this.#qcap,
      0,
      new Uint32Array([maxPairs, nB]),
    );
    if (this.#posA) this.device.queue.writeBuffer(this.#posA, 0, posA);
    if (this.#posB) this.device.queue.writeBuffer(this.#posB, 0, posB);
    if (
      !this.#bind &&
      this.#posA &&
      this.#posB &&
      this.#pairCount &&
      this.#pairs
    ) {
      this.#bind = this.#query.bindGroup(this.device, [
        this.#grid.params,
        this.#posA,
        this.#grid.cellStart,
        this.#grid.counts,
        this.#grid.sorted,
        this.#posB,
        this.#pairCount,
        this.#pairs,
        this.#qcap,
      ]);
    }
  }

  dispatch(): void {
    if (!this.#bind || !this.#posA || !this.#pairCount) return;
    this.device.queue.writeBuffer(this.#pairCount, 0, new Uint32Array([0]));
    const enc = this.device.createCommandEncoder();
    this.#grid.encode(enc, this.#posA);
    const pass = enc.beginComputePass();
    this.#query.dispatch(pass, this.#bind, this.#nB);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  async read(): Promise<PairResult> {
    if (
      !this.#pairCount ||
      !this.#pairs ||
      !this.#countStaging ||
      !this.#pairStaging
    )
      return { count: 0, pairs: new Uint32Array(0), overflow: false };
    const c = await readU32(
      this.device,
      this.#pairCount,
      this.#countStaging,
      4,
    );
    const count = c[0];
    const kept = Math.min(count, this.#capacity);
    const pairs = await readU32(
      this.device,
      this.#pairs,
      this.#pairStaging,
      kept * 2 * 4,
    );
    return { count, pairs, overflow: count > this.#capacity };
  }
}
