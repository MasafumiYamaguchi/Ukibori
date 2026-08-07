/// <reference types="@webgpu/types" />

import { assertValidSpec, byteLength, elementSize } from "../buffer";
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
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
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

  async readBytes(): Promise<Uint8Array> {
    await this.gpu.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(this.gpu.getMappedRange());
    const out = new Uint8Array(byteLength(this.spec));
    const rowBytes = byteLength(this.spec) / this.spec.height;
    const paddedRow = paddedRowBytes(this.spec);
    for (let y = 0; y < this.spec.height; y++) {
      out.set(mapped.subarray(y * paddedRow, y * paddedRow + rowBytes), y * rowBytes);
    }
    this.gpu.unmap();
    return out;
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
