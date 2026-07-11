// A deep module for "draw an instanced 3D mesh": owns the mesh + instance
// buffers, the pipeline (with its vertex layout), the bind group, and the draw.
// The rock pass and the shield pass are two adapters of this one shape — adding
// a third 3D effect (a bloom sphere, a missile trail) is one more config object,
// not another ~57 lines of copy-pasted pipeline wiring.

import type { Mesh } from "./mesh";

// Mesh vertices live at fixed high shader locations so per-instance attributes
// (0..N-1) never collide with them, regardless of how many an instance has.
const MESH_POS_LOC = 6;
const MESH_NRM_LOC = 7;

/**
 * One source of truth for an instance layout. `fields` is a flat list of scalar
 * names (length a multiple of 4; use `"_"` for padding). It yields the float
 * count, the `float32x4` vertex attributes, and `idx` for named packing so a
 * caller writes `data[o + L.idx.radius]` instead of a magic `data[o + 2]`.
 * Insert a field and every offset shifts in lock-step — the WGSL `@location`
 * struct is the only thing left to keep in the same order.
 */
export interface InstanceLayout<T extends string> {
  readonly floats: number;
  readonly attrs: GPUVertexAttribute[];
  readonly idx: Record<T, number>;
}
export const instanceLayout = <T extends string>(
  fields: readonly T[],
): InstanceLayout<T> => ({
  floats: fields.length,
  attrs: Array.from({ length: fields.length / 4 }, (_, i) => ({
    shaderLocation: i,
    offset: i * 16,
    format: "float32x4" as const,
  })),
  idx: Object.fromEntries(fields.map((f, i) => [f, i])) as Record<T, number>,
});

export interface MeshPass {
  /** Upload `count` instances from `data` and draw them into `pass`. */
  draw(pass: GPURenderPassEncoder, data: Float32Array, count: number): void;
}

export interface MeshPassSpec<T extends string> {
  format: GPUTextureFormat;
  uniformBuffer: GPUBuffer;
  mesh: Mesh;
  shader: string;
  layout: InstanceLayout<T>;
  maxInstances: number;
  blend?: GPUBlendState; // omit for opaque
  depthFormat: GPUTextureFormat;
  depthWrite: boolean;
  depthCompare: GPUCompareFunction;
}

export const createMeshPass = <T extends string>(
  device: GPUDevice,
  spec: MeshPassSpec<T>,
): MeshPass => {
  const { mesh, layout } = spec;
  const meshBuffer = device.createBuffer({
    size: mesh.data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(meshBuffer, 0, mesh.data);
  const instanceBuffer = device.createBuffer({
    size: spec.maxInstances * layout.floats * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const module = device.createShaderModule({ code: spec.shader });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: layout.floats * 4,
          stepMode: "instance",
          attributes: layout.attrs,
        },
        {
          arrayStride: 6 * 4, // interleaved pos(3) + normal(3)
          stepMode: "vertex",
          attributes: [
            { shaderLocation: MESH_POS_LOC, offset: 0, format: "float32x3" },
            { shaderLocation: MESH_NRM_LOC, offset: 12, format: "float32x3" },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [{ format: spec.format, blend: spec.blend }],
    },
    // Y is flipped in clip space, which reverses winding on screen; skip culling.
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: spec.depthFormat,
      depthWriteEnabled: spec.depthWrite,
      depthCompare: spec.depthCompare,
    },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: spec.uniformBuffer } }],
  });

  return {
    draw(pass, data, count) {
      if (count === 0) return;
      device.queue.writeBuffer(
        instanceBuffer,
        0,
        data,
        0,
        count * layout.floats,
      );
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, instanceBuffer);
      pass.setVertexBuffer(1, meshBuffer);
      pass.draw(mesh.vertexCount, count);
    },
  };
};
