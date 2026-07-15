// Reusable GPU buffer IO primitives — the composable storage layer every kernel
// shares. Storage buffers hold the SoA fields (positions, velocities, forces);
// a uniform buffer carries per-dispatch params; readback copies a storage
// buffer to a MAP_READ staging buffer for CPU inspection (parity + render).

export const storageBuffer = (
  device: GPUDevice,
  byteLength: number,
  { readable = false }: { readable?: boolean } = {},
): GPUBuffer =>
  device.createBuffer({
    size: byteLength,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      (readable ? GPUBufferUsage.COPY_SRC : 0),
  });

export const uniformBuffer = (
  device: GPUDevice,
  byteLength: number,
): GPUBuffer =>
  device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

export const readbackBuffer = (
  device: GPUDevice,
  byteLength: number,
): GPUBuffer =>
  device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

// Copy `src` → `staging` and map it, returning a fresh Float32Array copy (the
// mapped range is invalidated on unmap, so we slice out an owned buffer).
export const readFloats = async (
  device: GPUDevice,
  src: GPUBuffer,
  staging: GPUBuffer,
  byteLength: number,
): Promise<Float32Array> => {
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, 0, staging, 0, byteLength);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  return out;
};

// Same as readFloats but reinterprets the bytes as u32 — for index/count buffers
// (grid ids, candidate-pair lists) the GPU writes as integers.
export const readU32 = async (
  device: GPUDevice,
  src: GPUBuffer,
  staging: GPUBuffer,
  byteLength: number,
): Promise<Uint32Array> => {
  if (byteLength === 0) return new Uint32Array(0);
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, 0, staging, 0, byteLength);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ, 0, byteLength);
  // staging may be oversized (capacity) — map only the bytes we copied.
  const out = new Uint32Array(staging.getMappedRange(0, byteLength).slice(0));
  staging.unmap();
  return out;
};
