// PursuitKernel — per-ship foe reduction + pursuit steering force in one brute
// O(n^2) pass. Unlike the flock terms (short radius -> spatial grid), the engage
// radius is near arena-scale so there is no grid to build: every thread scans
// all ships, picks one foe (argmax priority / argmin distance), and derives the
// force. Owns three SoA inputs (posHead, combat, health), the force output, and
// a params uniform carrying the per-level engage tables + tuning constants.

import {
  readbackBuffer,
  readFloats,
  storageBuffer,
  uniformBuffer,
} from "../buffers";
import { compose, Kernel } from "../kernel";
import lib from "../wgsl/lib.wgsl" with { type: "text" };
import pursuit from "../wgsl/pursuit.wgsl" with { type: "text" };
import type { Arena } from "./separation";

// 12 scalars (48 B) + 5×vec4 level table (80 B).
const PURSUIT_PARAMS_BYTES = 48 + 5 * 16;

// The tuning the pursuit force reads. Per-level arrays are indexed by level-1;
// scalars mirror the tuning.ts constants of the same name.
export interface PursuitTuning {
  readonly engageGain: readonly number[]; // ENGAGE_GAIN[level-1]
  readonly engageRadius: readonly number[]; // ENGAGE_RADIUS[level-1]
  readonly kiteDist: readonly number[]; // KITE_DIST[level-1]
  readonly coordMinLevel: number; // COORDINATE_MIN_LEVEL
  readonly concaveGain: number; // CONCAVE_GAIN
  readonly concaveCommitDist: number; // CONCAVE_COMMIT_DIST
  readonly vetBounty: number; // TARGET_VETERAN_BOUNTY
  readonly aggroMin: number;
  readonly aggroMax: number;
  readonly aggroFavor: number;
  readonly aggroFear: number;
}

export class PursuitKernel {
  private readonly kernel: Kernel;
  private readonly params: GPUBuffer;
  private posHead: GPUBuffer | null = null;
  private combat: GPUBuffer | null = null;
  private health: GPUBuffer | null = null;
  private force: GPUBuffer | null = null;
  private staging: GPUBuffer | null = null;
  private bind: GPUBindGroup | null = null;
  private n = 0;

  constructor(private readonly device: GPUDevice) {
    this.kernel = new Kernel(device, {
      label: "pursuit",
      code: compose(lib, pursuit),
    });
    this.params = uniformBuffer(device, PURSUIT_PARAMS_BYTES);
  }

  private realloc(n: number): void {
    this.posHead?.destroy();
    this.combat?.destroy();
    this.health?.destroy();
    this.force?.destroy();
    this.staging?.destroy();
    this.posHead = storageBuffer(this.device, n * 4 * 4);
    this.combat = storageBuffer(this.device, n * 4 * 4);
    this.health = storageBuffer(this.device, n * 4 * 4);
    this.force = storageBuffer(this.device, n * 2 * 4, { readable: true });
    this.staging = readbackBuffer(this.device, n * 2 * 4);
    this.bind = this.kernel.bindGroup(this.device, [
      this.params,
      this.posHead,
      this.combat,
      this.health,
      this.force,
    ]);
    this.n = n;
  }

  private writeParams(n: number, arena: Arena, t: PursuitTuning): void {
    const buf = new ArrayBuffer(PURSUIT_PARAMS_BYTES);
    const u = new Uint32Array(buf, 0, 1);
    const f = new Float32Array(buf);
    u[0] = n;
    f[1] = arena.w;
    f[2] = arena.h;
    f[3] = t.coordMinLevel;
    f[4] = t.concaveGain;
    f[5] = t.concaveCommitDist;
    f[6] = t.vetBounty;
    // f[7] pad
    f[8] = t.aggroMin;
    f[9] = t.aggroMax;
    f[10] = t.aggroFavor;
    f[11] = t.aggroFear;
    for (let l = 0; l < 5; l++) {
      const base = 12 + l * 4; // vec4 stride
      f[base] = t.engageGain[l] ?? 0;
      f[base + 1] = t.engageRadius[l] ?? 0;
      f[base + 2] = t.kiteDist[l] ?? 0;
    }
    this.device.queue.writeBuffer(this.params, 0, buf);
  }

  // posHead [x,y,dx,dy], combat [team,level,archetype,id], health
  // [hp,maxHp,fuel,maxFuel] — each Float32Array of length n*4.
  upload(
    posHead: Float32Array,
    combat: Float32Array,
    health: Float32Array,
    n: number,
    arena: Arena,
    t: PursuitTuning,
  ): void {
    if (n !== this.n) this.realloc(n);
    this.writeParams(n, arena, t);
    if (this.posHead) this.device.queue.writeBuffer(this.posHead, 0, posHead);
    if (this.combat) this.device.queue.writeBuffer(this.combat, 0, combat);
    if (this.health) this.device.queue.writeBuffer(this.health, 0, health);
  }

  dispatch(): void {
    if (!this.bind) return;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    this.kernel.dispatch(pass, this.bind, this.n);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  async read(): Promise<Float32Array> {
    if (!this.force || !this.staging) return new Float32Array(0);
    return readFloats(this.device, this.force, this.staging, this.n * 2 * 4);
  }
}
