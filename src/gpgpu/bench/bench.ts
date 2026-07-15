// Browser entry for the GPGPU parity + bench harness. Runs the separation
// kernel CPU-vs-GPU across ship counts, exposing `window.__bench()` for the
// playwright driver (scripts/gpgpu-bench.ts) to await and print. Kept out of
// `bun test` because it needs a real GPU adapter.

import {
  AGGRO_FAVOR,
  AGGRO_FEAR,
  AGGRO_MAX,
  AGGRO_MIN,
  CONCAVE_COMMIT_DIST,
  CONCAVE_GAIN,
  COORDINATE_MIN_LEVEL,
  ENGAGE_GAIN,
  ENGAGE_RADIUS,
  KITE_DIST,
  TARGET_VETERAN_BOUNTY,
} from "../../world/tuning";
import { acquireComputeDevice } from "../device";
import { CrossPairKernel } from "../kernels/cross";
import { FlockKernel, type FlockTuning } from "../kernels/flock";
import { CandidatePairKernel } from "../kernels/pairs";
import { PursuitKernel, type PursuitTuning } from "../kernels/pursuit";
import type { Arena } from "../kernels/separation";
import { SeparationKernel } from "../kernels/separation";
import { SeparationGridKernel } from "../kernels/separation-grid";
import {
  compare,
  comparePairs,
  cpuCandidatePairs,
  cpuCrossPairs,
  cpuFlock,
  cpuPursuit,
  cpuSeparation,
  type Divergence,
  makeField,
  makeFlockField,
  makePursuitField,
  type Pairs,
} from "../parity";

// Both kernels expose this shape, so the timing helpers are kernel-agnostic.
interface SepKernel {
  upload(positions: Float32Array, n: number, arena: Arena, r: number): void;
  dispatch(): void;
  read(): Promise<Float32Array>;
}

const ARENA: Arena = { w: 320, h: 180 };
const R = 14;
const SIZES = [512, 2048, 8192, 16384];
const REL_ERR_BUDGET = 0.05; // 5% — plausible-divergence gate

// Flock kernel tuning (separation + align + cohere). flockR > sepR so the grid
// cell is sized to the larger radius and the shared 3×3 walk covers both.
const FLOCK: FlockTuning = {
  sepR: 14,
  sepGain: 1,
  flockR: 22,
  alignGain: 0.6,
  cohereGain: 0.35,
};

// Pursuit tuning pulled straight from the sim so the GPU (which bakes matching
// consts into WGSL) is graded against the real numbers — parity catches drift.
const PURSUIT: PursuitTuning = {
  engageGain: ENGAGE_GAIN,
  engageRadius: ENGAGE_RADIUS,
  kiteDist: KITE_DIST,
  coordMinLevel: COORDINATE_MIN_LEVEL,
  concaveGain: CONCAVE_GAIN,
  concaveCommitDist: CONCAVE_COMMIT_DIST,
  vetBounty: TARGET_VETERAN_BOUNTY,
  aggroMin: AGGRO_MIN,
  aggroMax: AGGRO_MAX,
  aggroFavor: AGGRO_FAVOR,
  aggroFear: AGGRO_FEAR,
};

// Ship-collision band (SEMITOUCH radius, sqrt(484)). Short → the grid applies.
const PAIR_R = 22;
// Density held constant (~253 px²/ship, the 480×270 @512 baseline) by scaling the
// arena area with n, so candidate-pair counts (and the buffer cap) stay realistic
// across sizes instead of exploding in a fixed worst-case arena.
const pairArena = (n: number): Arena => {
  const area = 253 * n;
  const w = Math.round(Math.sqrt((area * 16) / 9));
  return { w, h: Math.round((w * 9) / 16) };
};

// Cross-set query radius: BULLET_RADIUS (3.5) + max shipRadius (9.2). Bullets
// query a grid of ships; the fixed max radius is the broad-phase superset, the
// CPU narrow-phase applies the exact per-pair radius downstream.
const CROSS_R = 12.7;

const cpuIters = (n: number) => (n <= 2048 ? 20 : 5);
const roundtripIters = (n: number) => (n <= 2048 ? 30 : 10);

const meanSyncMs = (iters: number, run: () => void): number => {
  const t0 = performance.now();
  for (let k = 0; k < iters; k++) run();
  return (performance.now() - t0) / iters;
};

const meanAsyncMs = async (
  iters: number,
  run: () => Promise<void>,
): Promise<number> => {
  const t0 = performance.now();
  for (let k = 0; k < iters; k++) await run();
  return (performance.now() - t0) / iters;
};

const benchCpu = (field: Float32Array, n: number) => {
  let cpuRef: Float32Array<ArrayBufferLike> = new Float32Array(0);
  const cpuMs = meanSyncMs(cpuIters(n), () => {
    cpuRef = cpuSeparation(field, n, ARENA, R);
  });
  return { cpuMs, cpuRef };
};

// Upload once, warm up, then time 50 back-to-back dispatches INCLUDING the final
// flush — the flush must be inside the timed span or this measures CPU submit
// cost, not GPU execution. This is the resident-tier cost: no per-tick readback,
// forces stay GPU-side to feed the next kernel.
const benchGpuCompute = async (
  kernel: SepKernel,
  queue: GPUQueue,
  field: Float32Array,
  n: number,
) => {
  kernel.upload(field, n, ARENA, R);
  kernel.dispatch();
  await queue.onSubmittedWorkDone();
  const iters = 50;
  const t0 = performance.now();
  for (let k = 0; k < iters; k++) kernel.dispatch();
  await queue.onSubmittedWorkDone();
  return (performance.now() - t0) / iters;
};

// Per-tick cost with full marshalling: upload + dispatch + read each iter.
const benchGpuRoundtrip = (kernel: SepKernel, field: Float32Array, n: number) =>
  meanAsyncMs(roundtripIters(n), async () => {
    kernel.upload(field, n, ARENA, R);
    kernel.dispatch();
    await kernel.read();
  });

// Time + validate one GPU kernel against the CPU reference.
const benchKernel = async (
  kernel: SepKernel,
  queue: GPUQueue,
  field: Float32Array,
  n: number,
  cpuRef: Float32Array,
) => {
  const computeMs = await benchGpuCompute(kernel, queue, field, n);
  const roundtripMs = await benchGpuRoundtrip(kernel, field, n);
  const out = await kernel.read();
  return { computeMs, roundtripMs, div: compare(cpuRef, out) };
};

const fmt = (
  cpuMs: number,
  computeMs: number,
  roundtripMs: number,
  div: Divergence,
) => ({
  computeMs: +computeMs.toFixed(3),
  roundtripMs: +roundtripMs.toFixed(3),
  speedup: +(cpuMs / computeMs).toFixed(1),
  roundtripSpeedup: +(cpuMs / roundtripMs).toFixed(1),
  marshallMs: +(roundtripMs - computeMs).toFixed(3),
  maxRelErr: div.maxRelErr,
  pass: div.maxRelErr <= REL_ERR_BUDGET,
});

const benchSize = async (
  brute: SepKernel,
  grid: SepKernel,
  queue: GPUQueue,
  n: number,
) => {
  const field = makeField(n, ARENA);
  const { cpuMs, cpuRef } = benchCpu(field, n);
  const b = await benchKernel(brute, queue, field, n, cpuRef);
  const g = await benchKernel(grid, queue, field, n, cpuRef);
  return {
    n,
    cpuMs: +cpuMs.toFixed(3),
    brute: fmt(cpuMs, b.computeMs, b.roundtripMs, b.div),
    grid: fmt(cpuMs, g.computeMs, g.roundtripMs, g.div),
    gridVsBrute: +(b.computeMs / g.computeMs).toFixed(2),
  };
};

// Flock (separation+align+cohere): brute-CPU oracle vs the grid GPU kernel.
const benchFlockSize = async (
  kernel: FlockKernel,
  queue: GPUQueue,
  n: number,
) => {
  const { posHead, velTeam } = makeFlockField(n, ARENA);
  let cpuRef: Float32Array<ArrayBufferLike> = new Float32Array(0);
  const cpuMs = meanSyncMs(cpuIters(n), () => {
    cpuRef = cpuFlock(posHead, velTeam, n, ARENA, FLOCK);
  });

  kernel.upload(posHead, velTeam, n, ARENA, FLOCK);
  kernel.dispatch();
  await queue.onSubmittedWorkDone();
  const iters = 50;
  let t0 = performance.now();
  for (let k = 0; k < iters; k++) kernel.dispatch();
  await queue.onSubmittedWorkDone();
  const computeMs = (performance.now() - t0) / iters;

  const rt = roundtripIters(n);
  t0 = performance.now();
  for (let k = 0; k < rt; k++) {
    kernel.upload(posHead, velTeam, n, ARENA, FLOCK);
    kernel.dispatch();
    await kernel.read();
  }
  const roundtripMs = (performance.now() - t0) / rt;

  const out = await kernel.read();
  return {
    n,
    cpuMs: +cpuMs.toFixed(3),
    ...fmt(cpuMs, computeMs, roundtripMs, compare(cpuRef, out)),
  };
};

// Pursuit (foe reduction + steering force): brute-CPU oracle vs the GPU kernel.
// No grid (engageR is near arena-scale) — pure per-ship parallel reduction.
const benchPursuitSize = async (
  kernel: PursuitKernel,
  queue: GPUQueue,
  n: number,
) => {
  const { posHead, combat, health } = makePursuitField(n, ARENA);
  let cpuRef: Float32Array<ArrayBufferLike> = new Float32Array(0);
  const cpuMs = meanSyncMs(cpuIters(n), () => {
    cpuRef = cpuPursuit(posHead, combat, health, n, ARENA);
  });

  kernel.upload(posHead, combat, health, n, ARENA, PURSUIT);
  kernel.dispatch();
  await queue.onSubmittedWorkDone();
  const iters = 50;
  let t0 = performance.now();
  for (let k = 0; k < iters; k++) kernel.dispatch();
  await queue.onSubmittedWorkDone();
  const computeMs = (performance.now() - t0) / iters;

  const rt = roundtripIters(n);
  t0 = performance.now();
  for (let k = 0; k < rt; k++) {
    kernel.upload(posHead, combat, health, n, ARENA, PURSUIT);
    kernel.dispatch();
    await kernel.read();
  }
  const roundtripMs = (performance.now() - t0) / rt;

  const out = await kernel.read();
  return {
    n,
    cpuMs: +cpuMs.toFixed(3),
    ...fmt(cpuMs, computeMs, roundtripMs, compare(cpuRef, out)),
  };
};

// Candidate-pair broad-phase (P5 hybrid): GPU grid pair enumeration vs the CPU
// brute O(n²) scan. Validates SET equality (GPU emits every in-band pair), not
// force divergence. Buffer cap is sized from the exact CPU count + margin.
const benchPairsSize = async (
  kernel: CandidatePairKernel,
  queue: GPUQueue,
  n: number,
) => {
  const arena = pairArena(n);
  const field = makeField(n, arena, 0x2f11);
  let cp: Pairs = { count: 0, pairs: new Uint32Array(0) };
  const cpuMs = meanSyncMs(cpuIters(n), () => {
    cp = cpuCandidatePairs(field, n, arena, PAIR_R);
  });
  const maxPairs = Math.ceil(cp.count * 1.15) + 256;

  kernel.upload(field, n, arena, PAIR_R, maxPairs);
  kernel.dispatch();
  await queue.onSubmittedWorkDone();
  const iters = 50;
  let t0 = performance.now();
  for (let k = 0; k < iters; k++) kernel.dispatch();
  await queue.onSubmittedWorkDone();
  const computeMs = (performance.now() - t0) / iters;

  const rt = roundtripIters(n);
  t0 = performance.now();
  for (let k = 0; k < rt; k++) {
    kernel.upload(field, n, arena, PAIR_R, maxPairs);
    kernel.dispatch();
    await kernel.read();
  }
  const roundtripMs = (performance.now() - t0) / rt;

  const res = await kernel.read();
  const cmp = comparePairs(cp, res.pairs, n);
  return {
    n,
    arena: `${arena.w}×${arena.h}`,
    pairs: cp.count,
    cpuMs: +cpuMs.toFixed(3),
    computeMs: +computeMs.toFixed(3),
    roundtripMs: +roundtripMs.toFixed(3),
    speedup: +(cpuMs / computeMs).toFixed(1),
    roundtripSpeedup: +(cpuMs / roundtripMs).toFixed(1),
    overflow: res.overflow,
    match: cmp.match,
  };
};

// Cross-set broad-phase (P6): bullets (set B) queried against a ship grid (set
// A). GPU grid vs CPU brute O(B·A). SET equality, no force divergence.
const benchCrossSize = async (
  kernel: CrossPairKernel,
  queue: GPUQueue,
  n: number,
) => {
  const arena = pairArena(n);
  const ships = makeField(n, arena, 0x2f11);
  const bullets = makeField(n, arena, 0x7a3d); // set B, same count
  let cp: Pairs = { count: 0, pairs: new Uint32Array(0) };
  const cpuMs = meanSyncMs(cpuIters(n), () => {
    cp = cpuCrossPairs(bullets, ships, n, n, arena, CROSS_R);
  });
  const maxPairs = Math.ceil(cp.count * 1.15) + 256;

  kernel.upload(ships, bullets, n, n, arena, CROSS_R, maxPairs);
  kernel.dispatch();
  await queue.onSubmittedWorkDone();
  const iters = 50;
  let t0 = performance.now();
  for (let k = 0; k < iters; k++) kernel.dispatch();
  await queue.onSubmittedWorkDone();
  const computeMs = (performance.now() - t0) / iters;

  const rt = roundtripIters(n);
  t0 = performance.now();
  for (let k = 0; k < rt; k++) {
    kernel.upload(ships, bullets, n, n, arena, CROSS_R, maxPairs);
    kernel.dispatch();
    await kernel.read();
  }
  const roundtripMs = (performance.now() - t0) / rt;

  const res = await kernel.read();
  const cmp = comparePairs(cp, res.pairs, n);
  return {
    n,
    arena: `${arena.w}×${arena.h}`,
    pairs: cp.count,
    cpuMs: +cpuMs.toFixed(3),
    computeMs: +computeMs.toFixed(3),
    roundtripMs: +roundtripMs.toFixed(3),
    speedup: +(cpuMs / computeMs).toFixed(1),
    roundtripSpeedup: +(cpuMs / roundtripMs).toFixed(1),
    overflow: res.overflow,
    match: cmp.match,
  };
};

const runBench = async () => {
  const gpu = await acquireComputeDevice();
  if (!gpu) return { error: "WebGPU unavailable" };
  const brute = new SeparationKernel(gpu.device);
  const grid = new SeparationGridKernel(gpu.device);
  const flock = new FlockKernel(gpu.device);
  const pursuit = new PursuitKernel(gpu.device);
  const pairs = new CandidatePairKernel(gpu.device);
  const cross = new CrossPairKernel(gpu.device);
  const separation = [];
  const flockResults = [];
  const pursuitResults = [];
  const pairResults = [];
  const crossResults = [];
  for (const n of SIZES) {
    separation.push(await benchSize(brute, grid, gpu.device.queue, n));
    flockResults.push(await benchFlockSize(flock, gpu.device.queue, n));
    pursuitResults.push(await benchPursuitSize(pursuit, gpu.device.queue, n));
    pairResults.push(await benchPairsSize(pairs, gpu.device.queue, n));
    crossResults.push(await benchCrossSize(cross, gpu.device.queue, n));
  }
  return {
    adapter: { vendor: gpu.info.vendor, architecture: gpu.info.architecture },
    relErrBudget: REL_ERR_BUDGET,
    separation,
    flock: flockResults,
    pursuit: pursuitResults,
    pairs: pairResults,
    cross: crossResults,
  };
};

// biome-ignore lint/suspicious/noExplicitAny: test-harness bridge to playwright
(window as any).__bench = runBench;
const log = document.getElementById("log");
if (log) log.textContent = "ready";
