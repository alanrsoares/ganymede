// CandidatePairKernel — grid-accelerated broad-phase that emits every ship pair
// (i<j) within the collision band. This is the GPU half of the P5 hybrid: the
// CPU consumes the (sorted) pair list and runs the authoritative mutating
// narrow-phase, so the sim stays deterministic and golden-test-green while the
// O(n²) neighbour scan is lifted onto the grid.
//
// Capacity is explicit: the pairs buffer holds up to `maxPairs`; if the true
// count exceeds it the extra pairs are dropped (detectable — read() flags
// `overflow`). No silent truncation. Callers size it from a prior-tick count or
// a conservative bound.

import {
  readbackBuffer,
  readU32,
  storageBuffer,
  uniformBuffer,
} from "../buffers";
import { compose, Kernel } from "../kernel";
import lib from "../wgsl/lib.wgsl" with { type: "text" };
import pairsWgsl from "../wgsl/pairs.wgsl" with { type: "text" };
import { SpatialGrid } from "./grid";
import type { Arena } from "./separation";

export interface PairResult {
  count: number; // true pair count (may exceed capacity)
  pairs: Uint32Array; // flat [i0,j0,i1,j1,...], length 2*min(count,capacity)
  overflow: boolean;
}

export class CandidatePairKernel {
  readonly #grid: SpatialGrid;
  readonly #query: Kernel;
  readonly #cap: GPUBuffer;
  #pos: GPUBuffer | null = null;
  #pairCount: GPUBuffer | null = null;
  #pairs: GPUBuffer | null = null;
  #countStaging: GPUBuffer | null = null;
  #pairStaging: GPUBuffer | null = null;
  #bind: GPUBindGroup | null = null;
  #n = 0;
  #capacity = 0;

  constructor(private readonly device: GPUDevice) {
    this.#grid = new SpatialGrid(device);
    this.#query = new Kernel(device, {
      label: "pairs",
      code: compose(lib, pairsWgsl),
    });
    this.#cap = uniformBuffer(device, 16); // u32 maxPairs + pad
  }

  private realloc(n: number, capacity: number): void {
    this.#pos?.destroy();
    this.#pos = storageBuffer(this.device, n * 4 * 4);
    this.#n = n;
    this.#bind = null;
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
  }

  // positions: [x,y,_,_] per ship (n*4). r = collision band. maxPairs = output
  // capacity. Grid is (re)sized to r so the 3x3 walk covers the band.
  upload(
    positions: Float32Array,
    n: number,
    arena: Arena,
    r: number,
    maxPairs: number,
  ): void {
    if (n !== this.#n || maxPairs !== this.#capacity) this.realloc(n, maxPairs);
    this.#grid.configure(n, arena, r);
    this.device.queue.writeBuffer(this.#cap, 0, new Uint32Array([maxPairs]));
    if (this.#pos) this.device.queue.writeBuffer(this.#pos, 0, positions);
    if (!this.#bind && this.#pos && this.#pairCount && this.#pairs) {
      this.#bind = this.#query.bindGroup(this.device, [
        this.#grid.params,
        this.#pos,
        this.#grid.cellStart,
        this.#grid.counts,
        this.#grid.sorted,
        this.#pairCount,
        this.#pairs,
        this.#cap,
      ]);
    }
  }

  dispatch(): void {
    if (!this.#bind || !this.#pos || !this.#pairCount) return;
    this.device.queue.writeBuffer(this.#pairCount, 0, new Uint32Array([0])); // reset
    const enc = this.device.createCommandEncoder();
    this.#grid.encode(enc, this.#pos);
    const pass = enc.beginComputePass();
    this.#query.dispatch(pass, this.#bind, this.#n);
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
