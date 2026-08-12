import { HostBuffer } from "../buffer";
import type { BackendCapabilities, BufferSpec, RenderBackend, RenderBuffer } from "../types";
import { WasmNormalKernel } from "./kernel";
import type { WasmSelectionReport } from "./selection";

/**
 * #33 WASM-assisted CPU backend.
 *
 * A `RenderBackend` whose `kind` is `"wasm"` and whose capability report
 * states that the full height/normal/lighting/shadow pipeline can run with
 * the NORMAL stage executed by the WASM kernel (see `WasmCpuPipeline`).
 * Buffer allocation is identical to the CPU backend (HostBuffer semantics);
 * the WASM stage is reached through `WasmCpuPipeline`, never through the
 * buffer layer. The selection report (probe evidence, decision, fallback
 * reason) is carried on the backend so every consumer can report exactly
 * which stage runs in WASM.
 */
export class WasmCpuBackend implements RenderBackend {
  readonly kind = "wasm" as const;
  readonly capabilities: BackendCapabilities = {
    backend: "wasm",
    compute: true,
    readback: true,
    upload: true,
  };
  private disposed = false;

  constructor(
    readonly kernel: WasmNormalKernel,
    readonly selection: WasmSelectionReport,
  ) {}

  async createBuffer(spec: BufferSpec): Promise<RenderBuffer> {
    this.throwIfDisposed();
    return new HostBuffer(spec);
  }

  /** Release the kernel reference. Idempotent; late async completions are
   * ignored. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.kernel.dispose();
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new Error("WasmCpuBackend has been disposed");
    }
  }
}
