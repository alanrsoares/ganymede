import tgpu, { type TgpuRoot } from "typegpu";

export interface GpuContext {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  // TypeGPU root wrapping this exact device — the shared owner of every typed
  // buffer/bind group in the app. Reused (initFromDevice) rather than letting
  // TypeGPU request its own device, so raw and typed resources share one device.
  readonly root: TgpuRoot;
}

export const acquireGpu = async (
  canvas: HTMLCanvasElement,
): Promise<GpuContext> => {
  if (!navigator.gpu) throw new Error("WebGPU is not supported here");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter available");
  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Could not create WebGPU canvas context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const root = tgpu.initFromDevice({ device });

  return { device, context, format, root };
};
