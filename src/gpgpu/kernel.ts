// A composable compute kernel: one WGSL entry point + its pipeline, with a
// helper to bind buffers (by binding index) and encode a dispatch sized to an
// invocation count. Uses `layout: "auto"` — the bind-group layout is inferred
// from the shader, so a kernel is fully described by its WGSL + workgroup size.
// Kernels compose by sharing the `lib.wgsl` prelude via `compose()`.

export const compose = (...parts: string[]): string => parts.join("\n");

export interface KernelSpec {
  readonly code: string; // full WGSL (prelude already composed in)
  readonly entry?: string; // default "main"
  readonly workgroupSize?: number; // default 64; must match @workgroup_size
  readonly label?: string;
}

export class Kernel {
  readonly pipeline: GPUComputePipeline;
  private readonly wgSize: number;

  constructor(device: GPUDevice, spec: KernelSpec) {
    this.wgSize = spec.workgroupSize ?? 64;
    const module = device.createShaderModule({
      label: spec.label,
      code: spec.code,
    });
    this.pipeline = device.createComputePipeline({
      label: spec.label,
      layout: "auto",
      compute: { module, entryPoint: spec.entry ?? "main" },
    });
  }

  // Bind buffers in binding order: buffers[i] → @binding(i) of @group(0).
  bindGroup(device: GPUDevice, buffers: GPUBuffer[]): GPUBindGroup {
    return device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
  }

  // Bind with explicit @binding numbers — required when an entry point uses a
  // non-contiguous subset of the module's bindings (layout:"auto" infers a
  // layout with only the bindings that entry actually references).
  bindGroupAt(
    device: GPUDevice,
    entries: { binding: number; buffer: GPUBuffer }[],
  ): GPUBindGroup {
    return device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: entries.map(({ binding, buffer }) => ({
        binding,
        resource: { buffer },
      })),
    });
  }

  // Encode a dispatch covering `count` invocations (1D) onto an open pass.
  dispatch(
    pass: GPUComputePassEncoder,
    group: GPUBindGroup,
    count: number,
  ): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(count / this.wgSize));
  }
}
