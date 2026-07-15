// GPGPU device acquisition. Separate from the renderer's `acquireGpu` (which
// also configures a canvas context) — compute needs only an adapter + device.
// Returns null when WebGPU is unavailable so callers fall back to the CPU tick;
// compute is core WebGPU, so no optional features are requested.

export interface GpuCompute {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly info: GPUAdapterInfo;
}

export const acquireComputeDevice = async (): Promise<GpuCompute | null> => {
  if (typeof navigator === "undefined" || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  return { adapter, device, info: adapter.info };
};
