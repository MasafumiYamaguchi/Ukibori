import { HostBuffer } from "../buffer";
import type { BackendCapabilities, BufferSpec, RenderBackend, RenderBuffer } from "../types";

/**
 * CPU reference backend. All buffer math runs on host typed arrays, which is
 * how the deterministic tests and debug fixtures are verified. The WebGPU
 * backend must produce the same buffer semantics.
 */
export class CpuBackend implements RenderBackend {
  readonly kind = "cpu" as const;
  readonly capabilities: BackendCapabilities = {
    backend: "cpu",
    compute: true,
    readback: true,
    upload: true,
  };

  async createBuffer(spec: BufferSpec): Promise<RenderBuffer> {
    return new HostBuffer(spec);
  }

  dispose(): void {
    // Nothing to release.
  }
}
