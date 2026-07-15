// Browser entry for the GPGPU parity + bench harness. Runs the separation
// kernel CPU-vs-GPU across ship counts, exposing `window.__bench()` for the
// playwright driver (scripts/gpgpu-bench.ts) to await and print. Kept out of
// `bun test` because it needs a real GPU adapter.

import { acquireComputeDevice } from "../device";
import type { Arena } from "../kernels/separation";
import { SeparationKernel } from "../kernels/separation";
import { compare, cpuSeparation, makeField } from "../parity";

const ARENA: Arena = { w: 320, h: 180 };
const R = 14;
const SIZES = [512, 2048, 8192, 16384];
const REL_ERR_BUDGET = 0.05; // 5% — plausible-divergence gate

const runBench = async () => {
  const gpu = await acquireComputeDevice();
  if (!gpu) return { error: "WebGPU unavailable" };
  const kernel = new SeparationKernel(gpu.device);
  const results = [];

  for (const n of SIZES) {
    const field = makeField(n, ARENA);

    // CPU reference + timing (fewer iters at large n to stay bounded).
    const cpuIters = n <= 2048 ? 20 : 5;
    let cpuRef: Float32Array<ArrayBufferLike> = new Float32Array(0);
    let t0 = performance.now();
    for (let k = 0; k < cpuIters; k++)
      cpuRef = cpuSeparation(field, n, ARENA, R);
    const cpuMs = (performance.now() - t0) / cpuIters;

    // GPU compute-only: upload once, warm up, time back-to-back dispatches with
    // a single flush. This is the resident-tier cost — forces never leave the
    // GPU, they feed the next kernel in-place.
    kernel.upload(field, n, ARENA, R);
    kernel.dispatch();
    await gpu.device.queue.onSubmittedWorkDone();
    const gpuIters = 50;
    t0 = performance.now();
    for (let k = 0; k < gpuIters; k++) kernel.dispatch();
    await gpu.device.queue.onSubmittedWorkDone();
    const gpuMs = (performance.now() - t0) / gpuIters;

    // GPU roundtrip: the honest per-tick cost if the CPU needs results every
    // tick — re-upload positions, dispatch, read forces back. Each read()
    // flushes the whole submit (upload + compute + copy + map), so this
    // captures the full marshalling tax the residency plan exists to avoid.
    const rtIters = n <= 2048 ? 30 : 10;
    t0 = performance.now();
    for (let k = 0; k < rtIters; k++) {
      kernel.upload(field, n, ARENA, R);
      kernel.dispatch();
      await kernel.read();
    }
    const roundtripMs = (performance.now() - t0) / rtIters;

    const gpuOut = await kernel.read();
    const div = compare(cpuRef, gpuOut);
    results.push({
      n,
      cpuMs: +cpuMs.toFixed(3),
      gpuMs: +gpuMs.toFixed(3),
      roundtripMs: +roundtripMs.toFixed(3),
      speedup: +(cpuMs / gpuMs).toFixed(1),
      roundtripSpeedup: +(cpuMs / roundtripMs).toFixed(1),
      marshallMs: +(roundtripMs - gpuMs).toFixed(3),
      pass: div.maxRelErr <= REL_ERR_BUDGET,
      ...div,
    });
  }

  return {
    adapter: { vendor: gpu.info.vendor, architecture: gpu.info.architecture },
    relErrBudget: REL_ERR_BUDGET,
    results,
  };
};

// biome-ignore lint/suspicious/noExplicitAny: test-harness bridge to playwright
(window as any).__bench = runBench;
const log = document.getElementById("log");
if (log) log.textContent = "ready";
