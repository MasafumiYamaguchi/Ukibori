/// <reference types="@webgpu/types" />

import { assertValidSpec, byteLength, elementSize } from "../buffer";
import { GPU_USAGE_COPY_DST, GPU_USAGE_COPY_SRC, GPU_USAGE_MAP_READ, GPU_USAGE_STORAGE } from "../gpu/layout";
import type {
  BackendCapabilities,
  BufferSpec,
  RenderBackend,
  RenderBuffer,
} from "../types";

const ROW_ALIGN = 4;

/**
 * WebGPU buffer rows must start at 4-byte boundaries. The CPU memory layout is
 * tightly packed; padding is applied only inside this backend's transfer
 * layer so both backends agree on pixel semantics.
 */
function paddedRowBytes(spec: BufferSpec): number {
  const raw = spec.width * spec.channels * elementSize(spec.format);
  return Math.ceil(raw / ROW_ALIGN) * ROW_ALIGN;
}

function paddedByteLength(spec: BufferSpec): number {
  return paddedRowBytes(spec) * spec.height;
}

function hasGpuSupport(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof (navigator as { gpu?: unknown }).gpu !== "undefined"
  );
}

export async function isWebGpuSupported(): Promise<boolean> {
  if (!hasGpuSupport()) {
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * WebGPU backend skeleton for the verification environment.
 *
 * Buffer allocation and CPU<->GPU transfer are real; the height/normal/
 * lighting/shadow compute pipeline is not implemented yet (compute: false).
 * That pipeline is added by the geometry/lighting issues, which must not
 * depend on the CPU memory layout or pixel semantics defined here.
 *
 * #24 usage/readback design (fixed here):
 *
 * - PRODUCTION buffers are created with `STORAGE | COPY_DST | COPY_SRC`
 *   ONLY. They are never mapped, so they stay legal for compute passes
 *   (#25/#26) and never carry the invalid `STORAGE | MAP_READ`
 *   combination.
 * - Diagnostic `readBytes()` performs an explicit copy into a dedicated
 *   `MAP_READ | COPY_DST` STAGING buffer via `copyBufferToBuffer`, maps
 *   the staging buffer, copies the padded rows out, and destroys the
 *   staging allocation. Production buffers are never mapped and normal
 *   frames never read back.
 */
export class WebGpuBackend implements RenderBackend {
  readonly kind = "webgpu" as const;
  readonly capabilities: BackendCapabilities = {
    backend: "webgpu",
    compute: false,
    readback: true,
    upload: true,
  };

  constructor(private readonly device: GPUDevice) {}

  async createBuffer(spec: BufferSpec): Promise<RenderBuffer> {
    assertValidSpec(spec);
    const gpu = this.device.createBuffer({
      size: paddedByteLength(spec),
      usage: GPU_USAGE_STORAGE | GPU_USAGE_COPY_DST | GPU_USAGE_COPY_SRC,
    });
    return new WgpuBuffer(this.device, gpu, spec);
  }

  dispose(): void {
    this.device.destroy();
  }
}

class WgpuBuffer implements RenderBuffer {
  constructor(
    private readonly device: GPUDevice,
    private readonly gpu: GPUBuffer,
    readonly spec: BufferSpec,
  ) {}

  async writeBytes(bytes: Uint8Array, byteOffset = 0): Promise<void> {
    if (byteOffset !== 0 || bytes.byteLength !== byteLength(this.spec)) {
      throw new Error("WebGPU backend only supports full-buffer writes for now");
    }
    const padded = new Uint8Array(paddedByteLength(this.spec));
    const rowBytes = byteLength(this.spec) / this.spec.height;
    const paddedRow = paddedRowBytes(this.spec);
    for (let y = 0; y < this.spec.height; y++) {
      padded.set(bytes.subarray(y * rowBytes, (y + 1) * rowBytes), y * paddedRow);
    }
    this.device.queue.writeBuffer(this.gpu, 0, padded);
  }

  /**
   * Diagnostic readback: record a `copyBufferToBuffer` into a dedicated
   * `MAP_READ | COPY_DST` staging buffer on a `GPUCommandEncoder`, submit
   * it through `device.queue.submit(...)`, then map the STAGING buffer
   * only, unpad rows, and destroy the staging allocation. Production
   * buffers are never mapped and normal frames never read back.
   */
  async readBytes(): Promise<Uint8Array> {
    const size = paddedByteLength(this.spec);
    const staging = this.device.createBuffer({
      size,
      usage: GPU_USAGE_MAP_READ | GPU_USAGE_COPY_DST,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.gpu, 0, staging, 0, size);
      this.device.queue.submit([encoder.finish()]);
      // GPUMapMode.READ === 1 (spec-fixed bit value; the enum global is not
      // available in Node, where the staging path is tested with a mock).
      await staging.mapAsync(1);
      const mapped = new Uint8Array(staging.getMappedRange());
      const out = new Uint8Array(byteLength(this.spec));
      const rowBytes = byteLength(this.spec) / this.spec.height;
      const paddedRow = paddedRowBytes(this.spec);
      for (let y = 0; y < this.spec.height; y++) {
        out.set(mapped.subarray(y * paddedRow, y * paddedRow + rowBytes), y * rowBytes);
      }
      staging.unmap();
      return out;
    } finally {
      staging.destroy();
    }
  }

  dispose(): void {
    this.gpu.destroy();
  }
}

/** Create a WebGPU backend, or `null` when WebGPU is unavailable. */
export async function createWebGpuBackend(): Promise<WebGpuBackend | null> {
  if (!hasGpuSupport()) {
    return null;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) {
      return null;
    }
    const device = await adapter.requestDevice();
    return new WebGpuBackend(device);
  } catch {
    return null;
  }
}
