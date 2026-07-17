// SpatialGrid — the reusable broad-phase block. Builds a cell-sorted index of
// ships (clear -> count -> scan -> scatter) that any neighbour kernel queries in
// O(k) instead of O(n). Owns the grid buffers (counts, start offsets, scatter
// cursor, sorted ids) + shared GridParams; a consumer supplies the positions
// buffer and binds cellStart/cellCount/sortedIdx into its own query kernel.
//
// Cell edge = arena / floor(arena/r) >= r, so a 3x3 toroidal cell block is a
// conservative superset of every neighbour within r. Requires >=3 cells per
// axis (else the toroidal 3x3 wraps onto itself and double-counts) — holds for
// any arena at least 3r wide/tall.

import { storageBuffer, uniformBuffer } from "~/gpgpu/buffers";
import { compose, Kernel } from "~/gpgpu/kernel";
import gridWgsl from "~/gpgpu/wgsl/grid.wgsl" with { type: "text" };
import lib from "~/gpgpu/wgsl/lib.wgsl" with { type: "text" };
import type { Arena } from "./separation";

const GRID_PARAMS_BYTES = 32; // u32 n + f32×2 arena + f32×2 cell + u32×2 cells + f32 r

export class SpatialGrid {
  readonly params: GPUBuffer;
  private readonly clear: Kernel;
  private readonly count: Kernel;
  private readonly scan: Kernel;
  private readonly scatter: Kernel;

  private cellCount: GPUBuffer | null = null;
  private cellStartBuf: GPUBuffer | null = null;
  private cursor: GPUBuffer | null = null;
  private sortedIdx: GPUBuffer | null = null;
  private pos: GPUBuffer | null = null;
  private bindClear: GPUBindGroup | null = null;
  private bindCount: GPUBindGroup | null = null;
  private bindScan: GPUBindGroup | null = null;
  private bindScatter: GPUBindGroup | null = null;

  private n = 0;
  private cells = 0;

  constructor(private readonly device: GPUDevice) {
    const code = compose(lib, gridWgsl);
    this.clear = new Kernel(device, {
      label: "grid.clear",
      code,
      entry: "clear",
    });
    this.count = new Kernel(device, {
      label: "grid.count",
      code,
      entry: "count",
    });
    // scan is serial: one invocation walks every cell (@workgroup_size(1)).
    this.scan = new Kernel(device, {
      label: "grid.scan",
      code,
      entry: "scan",
      workgroupSize: 1,
    });
    this.scatter = new Kernel(device, {
      label: "grid.scatter",
      code,
      entry: "scatter",
    });
    this.params = uniformBuffer(device, GRID_PARAMS_BYTES);
  }

  // Buffers exposed for a consumer kernel's query bind group.
  get cellStart(): GPUBuffer {
    if (!this.cellStartBuf) throw new Error("SpatialGrid not configured");
    return this.cellStartBuf;
  }
  get counts(): GPUBuffer {
    if (!this.cellCount) throw new Error("SpatialGrid not configured");
    return this.cellCount;
  }
  get sorted(): GPUBuffer {
    if (!this.sortedIdx) throw new Error("SpatialGrid not configured");
    return this.sortedIdx;
  }

  // Size the grid to n ships in `arena` with interaction radius r, (re)allocating
  // buffers only when n or the cell count changes.
  configure(n: number, arena: Arena, r: number): void {
    const ncx = Math.floor(arena.w / r);
    const ncy = Math.floor(arena.h / r);
    if (ncx < 3 || ncy < 3)
      throw new Error(
        `arena too small for grid: ${ncx}×${ncy} cells (need ≥3)`,
      );
    const cellW = arena.w / ncx;
    const cellH = arena.h / ncy;
    const cells = ncx * ncy;

    if (n !== this.n || cells !== this.cells) {
      this.cellCount?.destroy();
      this.cellStartBuf?.destroy();
      this.cursor?.destroy();
      this.sortedIdx?.destroy();
      this.cellCount = storageBuffer(this.device, cells * 4);
      this.cellStartBuf = storageBuffer(this.device, cells * 4);
      this.cursor = storageBuffer(this.device, cells * 4);
      this.sortedIdx = storageBuffer(this.device, n * 4);
      this.n = n;
      this.cells = cells;
      this.pos = null; // force rebind next build()
    }

    const p = new ArrayBuffer(GRID_PARAMS_BYTES);
    const u = new Uint32Array(p);
    const f = new Float32Array(p);
    u[0] = n;
    f[1] = arena.w;
    f[2] = arena.h;
    f[3] = cellW;
    f[4] = cellH;
    u[5] = ncx;
    u[6] = ncy;
    f[7] = r;
    this.device.queue.writeBuffer(this.params, 0, p);
  }

  private rebind(pos: GPUBuffer): void {
    const cc = this.cellCount;
    const cs = this.cellStartBuf;
    const cur = this.cursor;
    const si = this.sortedIdx;
    if (!cc || !cs || !cur || !si)
      throw new Error("SpatialGrid not configured");
    this.bindClear = this.clear.bindGroupAt(this.device, [
      { binding: 0, buffer: this.params },
      { binding: 2, buffer: cc },
    ]);
    this.bindCount = this.count.bindGroupAt(this.device, [
      { binding: 0, buffer: this.params },
      { binding: 1, buffer: pos },
      { binding: 2, buffer: cc },
    ]);
    this.bindScan = this.scan.bindGroupAt(this.device, [
      { binding: 0, buffer: this.params },
      { binding: 2, buffer: cc },
      { binding: 3, buffer: cs },
      { binding: 4, buffer: cur },
    ]);
    this.bindScatter = this.scatter.bindGroupAt(this.device, [
      { binding: 0, buffer: this.params },
      { binding: 1, buffer: pos },
      { binding: 4, buffer: cur },
      { binding: 5, buffer: si },
    ]);
    this.pos = pos;
  }

  // Encode the four build passes into `enc`. Separate passes give guaranteed
  // ordering (each pass sees the prior's writes). Consumer submits the encoder.
  encode(enc: GPUCommandEncoder, pos: GPUBuffer): void {
    if (this.pos !== pos) this.rebind(pos);
    const groups: [Kernel, GPUBindGroup, number][] = [
      [this.clear, this.bindClear as GPUBindGroup, this.cells],
      [this.count, this.bindCount as GPUBindGroup, this.n],
      [this.scan, this.bindScan as GPUBindGroup, 1],
      [this.scatter, this.bindScatter as GPUBindGroup, this.n],
    ];
    for (const [kernel, group, count] of groups) {
      const pass = enc.beginComputePass();
      kernel.dispatch(pass, group, count);
      pass.end();
    }
  }
}
